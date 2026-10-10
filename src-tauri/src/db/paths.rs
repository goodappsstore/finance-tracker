use super::*;

pub fn resolve_db_path(explicit: Option<PathBuf>) -> Result<PathBuf, AppError> {
    if let Some(path) = explicit {
        return Ok(path);
    }
    if let Some(path) = env::var_os("FINANCE_TRACKER_DB_PATH") {
        return Ok(PathBuf::from(path));
    }
    default_db_path()
}

pub fn db_requires_init(path: &Path) -> Result<bool, AppError> {
    if !path.exists() {
        return Ok(true);
    }

    let db = Db::open(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    Ok(!db.is_initialized()?)
}

fn default_db_path() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data)
            .join("Finance Tracker")
            .join("tracker.db"));
    }

    let dirs = ProjectDirs::from("", "", "Finance Tracker").ok_or_else(|| {
        AppError::Config("unable to determine a default application data directory".to_string())
    })?;
    Ok(dirs.data_local_dir().join("tracker.db"))
}
