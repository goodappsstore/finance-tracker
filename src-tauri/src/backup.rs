use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Local;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{db::CURRENT_SCHEMA_VERSION, AppState, Db};

pub const CANCELLED_ERROR: &str = "BACKUP_CANCELLED";
const MANIFEST_FILE: &str = ".finance-tracker-backup.json";
const BACKUP_FORMAT_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
struct BackupManifest {
    format_version: u32,
    created_at: String,
    database_file: String,
}

#[derive(Serialize)]
pub struct BackupResult {
    source_dir: String,
    target_dir: String,
    folder_name: String,
    copied_files_count: usize,
    copied_files: Vec<String>,
}

#[derive(Serialize)]
pub struct BackupPreview {
    backup_dir: String,
    folder_name: String,
    database_file: String,
    reporting_currency: String,
    schema_version: i64,
    file_count: usize,
    total_bytes: u64,
    created_at: Option<String>,
}

#[derive(Serialize)]
pub struct RestoreResult {
    backup_dir: String,
    restored_files_count: usize,
    restored_files: Vec<String>,
    warnings: Vec<String>,
}

enum CopyFailure {
    Cancelled,
    Io(String),
}

struct StagingCleanup(PathBuf);

impl Drop for StagingCleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

impl CopyFailure {
    fn io(action: &str, path: &Path, error: std::io::Error) -> Self {
        Self::Io(format!("{action} {}: {error}", path.display()))
    }
}

fn ensure_not_cancelled(cancelled: &AtomicBool) -> Result<(), CopyFailure> {
    if cancelled.load(Ordering::Acquire) {
        Err(CopyFailure::Cancelled)
    } else {
        Ok(())
    }
}

fn is_sqlite_sidecar(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.ends_with("-wal") || name.ends_with("-shm")
}

fn is_restore_work_directory(relative_path: &Path) -> bool {
    let Some(name) = relative_path
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str())
    else {
        return false;
    };
    name.starts_with(".finance-tracker-restore-")
        && (name.ends_with(".staging") || name.ends_with(".rollback"))
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut path = db_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn copy_file(source: &Path, target: &Path, cancelled: &AtomicBool) -> Result<(), CopyFailure> {
    ensure_not_cancelled(cancelled)?;
    let mut input =
        File::open(source).map_err(|error| CopyFailure::io("Unable to open", source, error))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|error| CopyFailure::io("Unable to create", target, error))?;
    let mut buffer = vec![0_u8; 1024 * 1024];

    loop {
        ensure_not_cancelled(cancelled)?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| CopyFailure::io("Unable to read", source, error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| CopyFailure::io("Unable to write", target, error))?;
    }

    output
        .sync_all()
        .map_err(|error| CopyFailure::io("Unable to flush", target, error))?;
    let permissions = fs::metadata(source)
        .map_err(|error| CopyFailure::io("Unable to read metadata for", source, error))?
        .permissions();
    fs::set_permissions(target, permissions)
        .map_err(|error| CopyFailure::io("Unable to preserve permissions for", target, error))?;
    Ok(())
}

fn copy_directory(
    source: &Path,
    target: &Path,
    relative_prefix: &Path,
    copied_files: &mut Vec<String>,
    cancelled: &AtomicBool,
) -> Result<(), CopyFailure> {
    ensure_not_cancelled(cancelled)?;
    let entries = fs::read_dir(source)
        .map_err(|error| CopyFailure::io("Unable to read directory", source, error))?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CopyFailure::io("Unable to read an entry in", source, error))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        ensure_not_cancelled(cancelled)?;
        let file_type = entry
            .file_type()
            .map_err(|error| CopyFailure::io("Unable to inspect", &entry.path(), error))?;
        let file_name = entry.file_name();
        let source_path = entry.path();
        let target_path = target.join(&file_name);
        let relative_path = relative_prefix.join(&file_name);

        if file_type.is_dir() && !is_restore_work_directory(&relative_path) {
            fs::create_dir(&target_path).map_err(|error| {
                CopyFailure::io("Unable to create directory", &target_path, error)
            })?;
            copy_directory(
                &source_path,
                &target_path,
                &relative_path,
                copied_files,
                cancelled,
            )?;
        } else if file_type.is_file()
            && !is_sqlite_sidecar(&source_path)
            && relative_path != Path::new(MANIFEST_FILE)
        {
            copy_file(&source_path, &target_path, cancelled)?;
            copied_files.push(relative_path.to_string_lossy().to_string());
        }
    }
    Ok(())
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| {
        format!(
            "Unable to read backup directory {}: {error}",
            directory.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "Unable to read an entry in {}: {error}",
                directory.display()
            )
        })?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect {}: {error}", entry.path().display()))?;
        if file_type.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Backup contains an invalid file path".to_string())?
                .to_path_buf();
            if !is_safe_relative_path(&relative) {
                return Err("Backup contains an unsafe file path".into());
            }
            files.push(relative);
        }
    }
    files.sort();
    Ok(())
}

fn read_manifest(backup_dir: &Path) -> Result<Option<BackupManifest>, String> {
    let path = backup_dir.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Unable to read the backup manifest: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The backup manifest is invalid: {error}"))?;
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "Backup format {} is not supported by this version of Finance Tracker",
            manifest.format_version
        ));
    }
    if !is_safe_relative_path(Path::new(&manifest.database_file)) {
        return Err("The backup manifest contains an unsafe database path".into());
    }
    Ok(Some(manifest))
}

fn validate_database(path: &Path) -> Result<(String, i64), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Unable to open the backup database: {error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("Unable to validate the backup database: {error}"))?;
    if integrity != "ok" {
        return Err(format!(
            "The selected backup database failed its integrity check: {integrity}"
        ));
    }
    let (currency, schema_version): (String, i64) = connection
        .query_row(
            "SELECT currency, schema_version FROM metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("The selected folder is not a Finance Tracker backup: {error}"))?;
    if !(1..=CURRENT_SCHEMA_VERSION).contains(&schema_version) {
        return Err(format!(
            "This backup uses database schema {schema_version}, but this app supports schemas 1 through {CURRENT_SCHEMA_VERSION}"
        ));
    }
    Ok((currency, schema_version))
}

fn inspect_backup_at(
    state: &AppState,
    backup_dir: &str,
) -> Result<(PathBuf, BackupPreview), String> {
    let backup_dir = PathBuf::from(backup_dir.trim());
    if !backup_dir.is_dir() {
        return Err("Selected backup does not exist or is not a directory".into());
    }
    let backup_dir = fs::canonicalize(&backup_dir)
        .map_err(|error| format!("Unable to resolve the selected backup: {error}"))?;
    let db_path = state
        .db_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let source_dir = db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(crate::dirs_next);
    let source_dir = fs::canonicalize(&source_dir)
        .map_err(|error| format!("Unable to resolve the current data directory: {error}"))?;
    if backup_dir.starts_with(&source_dir) || source_dir.starts_with(&backup_dir) {
        return Err(
            "Choose a backup folder outside the current Finance Tracker data directory".into(),
        );
    }

    let manifest = read_manifest(&backup_dir)?;
    let database_file = manifest
        .as_ref()
        .map(|manifest| manifest.database_file.clone())
        .or_else(|| {
            db_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .ok_or_else(|| "Unable to determine the database filename".to_string())?;
    let database_relative = PathBuf::from(&database_file);
    if !is_safe_relative_path(&database_relative) {
        return Err("The backup contains an unsafe database path".into());
    }
    let database_path = backup_dir.join(&database_relative);
    if !database_path.is_file() {
        return Err(format!(
            "The selected folder does not contain the expected database file: {database_file}"
        ));
    }
    let (reporting_currency, schema_version) = validate_database(&database_path)?;

    let mut files = Vec::new();
    collect_files(&backup_dir, &backup_dir, &mut files)?;
    let total_bytes = files.iter().try_fold(0_u64, |total, relative| {
        let size = fs::metadata(backup_dir.join(relative))
            .map_err(|error| format!("Unable to inspect backup file: {error}"))?
            .len();
        total
            .checked_add(size)
            .ok_or_else(|| "Backup size is too large".to_string())
    })?;
    let folder_name = backup_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| backup_dir.to_string_lossy().to_string());
    let preview = BackupPreview {
        backup_dir: backup_dir.to_string_lossy().to_string(),
        folder_name,
        database_file,
        reporting_currency,
        schema_version,
        file_count: files.len(),
        total_bytes,
        created_at: manifest.map(|manifest| manifest.created_at),
    };
    Ok((backup_dir, preview))
}

pub fn inspect_backup(state: &AppState, backup_dir: &str) -> Result<BackupPreview, String> {
    inspect_backup_at(state, backup_dir).map(|(_, preview)| preview)
}

fn remove_staging_directory(staging_dir: &Path, reason: &str, cancelled: bool) -> String {
    match fs::remove_dir_all(staging_dir) {
        Ok(()) => reason.to_string(),
        Err(error) if cancelled => format!(
            "The operation was cancelled, but its incomplete staging folder could not be removed ({}): {error}",
            staging_dir.display(),
        ),
        Err(error) => format!(
            "{reason}. The incomplete staging folder could not be removed ({}): {error}",
            staging_dir.display(),
        ),
    }
}

fn write_manifest(path: &Path, manifest: &BackupManifest) -> Result<(), CopyFailure> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
        CopyFailure::Io(format!("Unable to serialize backup manifest: {error}"))
    })?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| CopyFailure::io("Unable to create", path, error))?;
    file.write_all(&bytes)
        .map_err(|error| CopyFailure::io("Unable to write", path, error))?;
    file.sync_all()
        .map_err(|error| CopyFailure::io("Unable to flush", path, error))
}

pub fn create_backup(
    state: &AppState,
    destination_dir: &str,
    cancelled: &AtomicBool,
    committing: &AtomicBool,
) -> Result<BackupResult, String> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let source_dir = db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(crate::dirs_next);

    if !source_dir.is_dir() {
        return Err(format!(
            "Source data directory does not exist: {}",
            source_dir.display()
        ));
    }

    let destination_dir = PathBuf::from(destination_dir.trim());
    if !destination_dir.is_dir() {
        return Err("Selected destination does not exist or is not a directory".into());
    }

    let canonical_source = fs::canonicalize(&source_dir)
        .map_err(|error| format!("Unable to resolve source data directory: {error}"))?;
    let canonical_destination = fs::canonicalize(&destination_dir)
        .map_err(|error| format!("Unable to resolve backup destination: {error}"))?;
    if canonical_destination.starts_with(&canonical_source) {
        return Err(
            "Choose a destination outside the Finance Tracker data directory to avoid copying the backup into itself"
                .into(),
        );
    }

    ensure_not_cancelled(cancelled).map_err(|_| CANCELLED_ERROR.to_string())?;

    let created_at = Local::now();
    let folder_name = format!(
        "finance-tracker-backup-{}",
        created_at.format("%Y-%m-%d_%H-%M-%S")
    );
    let target_dir = canonical_destination.join(&folder_name);
    if target_dir.exists() {
        return Err(format!(
            "Backup folder already exists: {}",
            target_dir.display()
        ));
    }
    let staging_dir = canonical_destination.join(format!(
        ".finance-tracker-backup-{}.partial",
        Uuid::new_v4()
    ));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Unable to create backup staging folder: {error}"))?;
    let _staging_cleanup = StagingCleanup(staging_dir.clone());

    let copy_result = (|| {
        // Keep the database path and connection locked from the checkpoint through
        // the final file copy. Other commands therefore cannot mutate or switch the
        // database while the snapshot is being assembled.
        let path_guard = state
            .db_path
            .lock()
            .map_err(|error| CopyFailure::Io(error.to_string()))?;
        if *path_guard != db_path {
            return Err(CopyFailure::Io(
                "The database path changed before the backup could start".into(),
            ));
        }
        let mut database = state
            .database
            .lock()
            .map_err(|error| CopyFailure::Io(error.to_string()))?;
        if database.as_ref().map(|(path, _)| path) != Some(&db_path) {
            *database = Some((
                db_path.clone(),
                Db::open_existing(&db_path).map_err(|error| CopyFailure::Io(error.to_string()))?,
            ));
        }
        let database = &database
            .as_ref()
            .ok_or_else(|| CopyFailure::Io("Unable to open the database for backup".into()))?
            .1;
        database
            .checkpoint_wal()
            .map_err(|error| CopyFailure::Io(error.to_string()))?;
        database
            .with_backup_write_lock(|| {
                ensure_not_cancelled(cancelled)?;
                let mut copied_files = Vec::new();
                copy_directory(
                    &canonical_source,
                    &staging_dir,
                    Path::new(""),
                    &mut copied_files,
                    cancelled,
                )?;
                let database_file = db_path
                    .file_name()
                    .ok_or_else(|| CopyFailure::Io("Unable to determine database filename".into()))?
                    .to_string_lossy()
                    .to_string();
                write_manifest(
                    &staging_dir.join(MANIFEST_FILE),
                    &BackupManifest {
                        format_version: BACKUP_FORMAT_VERSION,
                        created_at: created_at.to_rfc3339(),
                        database_file,
                    },
                )?;
                copied_files.push(MANIFEST_FILE.to_string());
                ensure_not_cancelled(cancelled)?;
                Ok(copied_files)
            })
            .map_err(|error| CopyFailure::Io(error.to_string()))?
    })();

    let mut copied_files = match copy_result {
        Ok(files) => files,
        Err(CopyFailure::Cancelled) => {
            return Err(remove_staging_directory(
                &staging_dir,
                CANCELLED_ERROR,
                true,
            ));
        }
        Err(CopyFailure::Io(message)) => {
            return Err(remove_staging_directory(
                &staging_dir,
                &format!("Backup failed: {message}"),
                false,
            ));
        }
    };

    let cancellation_won = {
        let _active_operation = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if cancelled.load(Ordering::Acquire) {
            true
        } else {
            committing.store(true, Ordering::Release);
            false
        }
    };
    if cancellation_won {
        return Err(remove_staging_directory(
            &staging_dir,
            CANCELLED_ERROR,
            true,
        ));
    }
    if let Err(error) = fs::rename(&staging_dir, &target_dir) {
        return Err(remove_staging_directory(
            &staging_dir,
            &format!("Unable to finalize backup: {error}"),
            false,
        ));
    }

    copied_files.sort();
    Ok(BackupResult {
        source_dir: canonical_source.to_string_lossy().to_string(),
        target_dir: target_dir.to_string_lossy().to_string(),
        folder_name,
        copied_files_count: copied_files.len(),
        copied_files,
    })
}

struct InstalledFile {
    target: PathBuf,
    rollback: Option<PathBuf>,
}

fn remove_db_sidecars(db_path: &Path) -> Result<(), String> {
    for suffix in ["-wal", "-shm"] {
        let path = sidecar_path(db_path, suffix);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "Unable to remove stale SQLite sidecar {}: {error}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn rollback_installed_files(installed: &[InstalledFile], db_path: &Path) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Err(error) = remove_db_sidecars(db_path) {
        failures.push(error);
    }
    for file in installed.iter().rev() {
        if file.target.exists() {
            if let Err(error) = fs::remove_file(&file.target) {
                failures.push(format!(
                    "Unable to remove restored file {}: {error}",
                    file.target.display()
                ));
                continue;
            }
        }
        if let Some(rollback) = &file.rollback {
            if let Some(parent) = file.target.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    failures.push(format!(
                        "Unable to recreate directory {}: {error}",
                        parent.display()
                    ));
                    continue;
                }
            }
            if let Err(error) = fs::rename(rollback, &file.target) {
                failures.push(format!(
                    "Unable to restore original file {}: {error}",
                    file.target.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn reopen_database_slot(
    database: &mut Option<(PathBuf, Db)>,
    db_path: &Path,
) -> Result<(), String> {
    match Db::open_existing(db_path) {
        Ok(db) => {
            *database = Some((db_path.to_path_buf(), db));
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn restore_backup(
    state: &AppState,
    backup_dir: &str,
    cancelled: &AtomicBool,
    committing: &AtomicBool,
) -> Result<RestoreResult, String> {
    let (backup_dir, preview) = inspect_backup_at(state, backup_dir)?;
    ensure_not_cancelled(cancelled).map_err(|_| CANCELLED_ERROR.to_string())?;

    let db_path = state
        .db_path
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let source_dir = db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(crate::dirs_next);
    let source_dir = fs::canonicalize(&source_dir)
        .map_err(|error| format!("Unable to resolve the current data directory: {error}"))?;
    let operation_suffix = Uuid::new_v4();
    let staging_dir = source_dir.join(format!(
        ".finance-tracker-restore-{operation_suffix}.staging"
    ));
    let rollback_dir = source_dir.join(format!(
        ".finance-tracker-restore-{operation_suffix}.rollback"
    ));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Unable to create restore staging folder: {error}"))?;
    let _staging_cleanup = StagingCleanup(staging_dir.clone());

    let mut staged_file_names = Vec::new();
    let staging_result = copy_directory(
        &backup_dir,
        &staging_dir,
        Path::new(""),
        &mut staged_file_names,
        cancelled,
    );
    match staging_result {
        Ok(()) => {}
        Err(CopyFailure::Cancelled) => {
            return Err(remove_staging_directory(
                &staging_dir,
                CANCELLED_ERROR,
                true,
            ));
        }
        Err(CopyFailure::Io(message)) => {
            return Err(remove_staging_directory(
                &staging_dir,
                &format!("Unable to stage restore data: {message}"),
                false,
            ));
        }
    }

    let backup_db_relative = PathBuf::from(&preview.database_file);
    validate_database(&staging_dir.join(&backup_db_relative)).map_err(|error| {
        remove_staging_directory(
            &staging_dir,
            &format!("The staged database could not be validated: {error}"),
            false,
        )
    })?;
    ensure_not_cancelled(cancelled)
        .map_err(|_| remove_staging_directory(&staging_dir, CANCELLED_ERROR, true))?;

    let current_db_relative = PathBuf::from(
        db_path
            .file_name()
            .ok_or_else(|| "Unable to determine the current database filename".to_string())?,
    );
    let staged_files = staged_file_names
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let mut mappings = Vec::new();
    let mut target_paths = HashSet::new();
    for source_relative in staged_files {
        if source_relative == Path::new(MANIFEST_FILE) || is_sqlite_sidecar(&source_relative) {
            continue;
        }
        if source_relative == Path::new(crate::DB_PATH_SETTINGS_FILE)
            && source_relative != backup_db_relative
        {
            // A database location is machine-specific. Keep the current selection
            // so a cross-device restore does not redirect the next app launch to
            // an absolute path from the machine that created the backup.
            continue;
        }
        let target_relative = if source_relative == backup_db_relative {
            current_db_relative.clone()
        } else {
            source_relative.clone()
        };
        if !target_paths.insert(target_relative.clone()) {
            let message = format!(
                "The backup maps more than one file to {}",
                target_relative.display()
            );
            return Err(remove_staging_directory(&staging_dir, &message, false));
        }
        let target = source_dir.join(&target_relative);
        if target.exists() && !target.is_file() {
            let message = format!(
                "Cannot restore {} because the destination is not a file",
                target.display()
            );
            return Err(remove_staging_directory(&staging_dir, &message, false));
        }
        mappings.push((source_relative, target_relative));
    }
    if !mappings
        .iter()
        .any(|(_, target)| target == &current_db_relative)
    {
        return Err(remove_staging_directory(
            &staging_dir,
            "The staged restore does not contain a database file",
            false,
        ));
    }

    let path_guard = state.db_path.lock().map_err(|error| error.to_string())?;
    if *path_guard != db_path {
        return Err(remove_staging_directory(
            &staging_dir,
            "The database path changed before the restore could start",
            false,
        ));
    }
    let mut database = state.database.lock().map_err(|error| error.to_string())?;
    if database.as_ref().map(|(path, _)| path) != Some(&db_path) {
        *database = Some((
            db_path.clone(),
            Db::open_existing(&db_path).map_err(|error| error.to_string())?,
        ));
    }
    database
        .as_ref()
        .ok_or_else(|| "Unable to open the current database before restore".to_string())?
        .1
        .checkpoint_wal()
        .map_err(|error| error.to_string())?;

    let cancellation_won = {
        // Cancellation and the transition to the irreversible file swap share
        // the same mutex as the command that requests cancellation. Exactly one
        // side therefore wins this boundary.
        let _active_operation = state
            .active_data_operation
            .lock()
            .map_err(|error| error.to_string())?;
        if cancelled.load(Ordering::Acquire) {
            true
        } else {
            committing.store(true, Ordering::Release);
            false
        }
    };
    if cancellation_won {
        drop(database);
        drop(path_guard);
        return Err(remove_staging_directory(
            &staging_dir,
            CANCELLED_ERROR,
            true,
        ));
    }

    *database = None;
    if let Err(error) = remove_db_sidecars(&db_path) {
        let reopen_error = reopen_database_slot(&mut database, &db_path).err();
        drop(database);
        drop(path_guard);
        let message = match reopen_error {
            Some(reopen_error) => {
                format!("{error}. The current database could not be reopened: {reopen_error}")
            }
            None => error,
        };
        return Err(remove_staging_directory(&staging_dir, &message, false));
    }
    if let Err(error) = fs::create_dir(&rollback_dir) {
        let reopen_error = reopen_database_slot(&mut database, &db_path).err();
        drop(database);
        drop(path_guard);
        let mut message = format!("Unable to create restore rollback folder: {error}");
        if let Some(reopen_error) = reopen_error {
            message.push_str(&format!(
                ". The current database could not be reopened: {reopen_error}"
            ));
        }
        return Err(remove_staging_directory(&staging_dir, &message, false));
    }

    let mut installed = Vec::new();
    let mut install_error = None;
    for (source_relative, target_relative) in &mappings {
        let staged = staging_dir.join(source_relative);
        let target = source_dir.join(target_relative);
        let rollback = rollback_dir.join(target_relative);
        if let Some(parent) = target.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                install_error = Some(format!(
                    "Unable to create restore destination {}: {error}",
                    parent.display()
                ));
                break;
            }
        }
        let previous = if target.exists() {
            if let Some(parent) = rollback.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    install_error = Some(format!(
                        "Unable to create rollback destination {}: {error}",
                        parent.display()
                    ));
                    break;
                }
            }
            if let Err(error) = fs::rename(&target, &rollback) {
                install_error = Some(format!(
                    "Unable to preserve current file {}: {error}",
                    target.display()
                ));
                break;
            }
            Some(rollback.clone())
        } else {
            None
        };
        if let Err(error) = fs::rename(&staged, &target) {
            if let Some(previous) = &previous {
                installed.push(InstalledFile {
                    target: target.clone(),
                    rollback: Some(previous.clone()),
                });
            }
            install_error = Some(format!(
                "Unable to install restored file {}: {error}",
                target.display()
            ));
            break;
        }
        installed.push(InstalledFile {
            target,
            rollback: previous,
        });
    }

    if install_error.is_none() {
        match Db::open_existing(&db_path) {
            Ok(restored_db) => *database = Some((db_path.clone(), restored_db)),
            Err(error) => {
                install_error = Some(format!(
                    "The restored database could not be opened: {error}"
                ));
            }
        }
    }

    if let Some(error) = install_error {
        *database = None;
        let rollback_error = rollback_installed_files(&installed, &db_path).err();
        let reopen_error = reopen_database_slot(&mut database, &db_path).err();
        drop(database);
        drop(path_guard);
        let _ = fs::remove_dir_all(&staging_dir);
        if rollback_error.is_none() {
            let _ = fs::remove_dir_all(&rollback_dir);
        }
        let mut details = vec![error];
        if let Some(rollback_error) = rollback_error {
            details.push(format!(
                "Automatic rollback was incomplete; recovery files remain in {}: {rollback_error}",
                rollback_dir.display()
            ));
        }
        if let Some(reopen_error) = reopen_error {
            details.push(format!(
                "The original database could not be reopened: {reopen_error}"
            ));
        }
        return Err(details.join(". "));
    }

    drop(database);
    drop(path_guard);
    let mut warnings = Vec::new();
    if let Err(error) = fs::remove_dir_all(&staging_dir) {
        warnings.push(format!(
            "The empty restore staging folder could not be removed ({}): {error}",
            staging_dir.display()
        ));
    }
    if let Err(error) = fs::remove_dir_all(&rollback_dir) {
        warnings.push(format!(
            "The restore succeeded, but old rollback files could not be removed ({}): {error}",
            rollback_dir.display()
        ));
    }

    let mut restored_files = mappings
        .into_iter()
        .map(|(_, target)| target.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    restored_files.sort();
    Ok(RestoreResult {
        backup_dir: backup_dir.to_string_lossy().to_string(),
        restored_files_count: restored_files.len(),
        restored_files,
        warnings,
    })
}
