use super::*;

impl Db {
    pub fn add_category(&self, name: &str, kind: &CategoryKind) -> Result<i64, AppError> {
        let normalized_name = normalize_name("category", name)?;
        match self.conn.execute(
            "INSERT INTO categories (name, kind) VALUES (?1, ?2)",
            params![normalized_name, kind.as_db_str()],
        ) {
            Ok(_) => Ok(self.conn.last_insert_rowid()),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::Category, &normalized_name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn list_categories(&self) -> Result<Vec<Category>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT id, name, kind, archived
             FROM categories
             WHERE archived = 0
             ORDER BY kind ASC, name COLLATE NOCASE",
        )?;

        let rows = statement.query_map([], |row| {
            let kind: String = row.get(2)?;
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: CategoryKind::from_db(&kind).map_err(map_db_error)?,
                archived: row.get::<_, i64>(3)? == 1,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn edit_category(
        &self,
        reference: &str,
        name: Option<&str>,
        kind: Option<&CategoryKind>,
    ) -> Result<i64, AppError> {
        let category_id = self.resolve_category_ref(reference, None)?;
        let (current_name, current_kind) = self.load_category(category_id)?;
        let next_name = match name {
            Some(value) => normalize_name("category", value)?,
            None => current_name.clone(),
        };
        let next_kind = kind.copied().unwrap_or(current_kind);

        if next_kind != current_kind && self.category_has_dependencies(category_id)? {
            return Err(AppError::Validation(
                "cannot change category kind while ledger data, budgets, rules, or tax settings still reference it"
                    .to_string(),
            ));
        }

        match self.conn.execute(
            "UPDATE categories
             SET name = ?1,
                 kind = ?2
             WHERE id = ?3",
            params![next_name, next_kind.as_db_str(), category_id],
        ) {
            Ok(0) => Err(AppError::invalid_ref(
                EntityKind::Category,
                reference.trim(),
            )),
            Ok(_) => Ok(category_id),
            Err(error) if is_unique_constraint(&error) => {
                Err(AppError::duplicate(EntityKind::Category, &next_name))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn delete_category(&self, reference: &str) -> Result<i64, AppError> {
        let tx = self.conn.unchecked_transaction()?;
        let category_id = self.resolve_category_ref(reference, None)?;
        let referenced: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM recurring_rules WHERE category_id=?1)
             OR EXISTS(SELECT 1 FROM planning_items WHERE category_id=?1 AND archived=0 AND linked_transaction_id IS NULL)
             OR EXISTS(SELECT 1 FROM budgets WHERE category_id=?1)
             OR EXISTS(SELECT 1 FROM scenario_budget_overrides WHERE category_id=?1)
             OR EXISTS(SELECT 1 FROM budget_rollovers WHERE category_id=?1)
             OR EXISTS(SELECT 1 FROM budget_moves WHERE from_category_id=?1 OR to_category_id=?1)
             OR EXISTS(SELECT 1 FROM transaction_rules WHERE set_category_id=?1)
             OR EXISTS(SELECT 1 FROM tax_category_settings WHERE category_id=?1)", [category_id], |r| r.get(0))?;
        if referenced {
            return Err(AppError::Validation("Remove rules, tax settings, pending plans, and budget references before archiving this category.".into()));
        }
        let changed = self.conn.execute(
            "UPDATE categories
             SET archived = 1
             WHERE id = ?1
               AND archived = 0",
            params![category_id],
        )?;
        if changed == 0 {
            return Err(AppError::invalid_ref(
                EntityKind::Category,
                reference.trim(),
            ));
        }
        tx.commit()?;
        Ok(category_id)
    }

    pub(super) fn category_name(&self, id: i64) -> Result<String, AppError> {
        self.conn
            .query_row(
                "SELECT name FROM categories WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("category `{id}` was not found")))
    }

    pub(super) fn load_category(&self, id: i64) -> Result<(String, CategoryKind), AppError> {
        self.conn
            .query_row(
                "SELECT name, kind
                 FROM categories
                 WHERE id = ?1",
                params![id],
                |row| {
                    let kind: String = row.get(1)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        CategoryKind::from_db(&kind).map_err(map_db_error)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("category `{id}` was not found")))
    }

    pub(super) fn category_has_dependencies(&self, category_id: i64) -> Result<bool, AppError> {
        let transaction_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL AND category_id = ?1",
            params![category_id],
            |row| row.get(0),
        )?;
        if transaction_count > 0 {
            return Ok(true);
        }

        let budget_count: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM budgets WHERE category_id = ?1)
                  + (SELECT COUNT(*) FROM budget_rollovers WHERE category_id = ?1)
                  + (SELECT COUNT(*) FROM budget_moves WHERE from_category_id = ?1 OR to_category_id = ?1)",
            params![category_id],
            |row| row.get(0),
        )?;
        if budget_count > 0 {
            return Ok(true);
        }

        let recurring_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM recurring_rules WHERE category_id = ?1",
            params![category_id],
            |row| row.get(0),
        )?;
        if recurring_count > 0 {
            return Ok(true);
        }

        let advanced_count: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM transaction_splits WHERE category_id=?1)
                  + (SELECT COUNT(*) FROM transaction_rules WHERE set_category_id=?1)
                  + (SELECT COUNT(*) FROM tax_category_settings WHERE category_id=?1)",
            params![category_id],
            |row| row.get(0),
        )?;
        Ok(advanced_count > 0)
    }

    pub(super) fn resolve_category_ref(
        &self,
        reference: &str,
        expected_kind: Option<&CategoryKind>,
    ) -> Result<i64, AppError> {
        let trimmed = reference.trim();
        let id_lookup = trimmed.parse::<i64>().ok();
        let row = self
            .conn
            .query_row(
                "SELECT id, kind
                 FROM categories
                 WHERE archived = 0
                   AND (id = ?1 OR name = ?2 COLLATE NOCASE)",
                params![id_lookup, trimmed],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let (category_id, actual_kind) =
            row.ok_or_else(|| AppError::invalid_ref(EntityKind::Category, trimmed))?;
        if let Some(expected) = expected_kind {
            validate_category_kind(expected, &actual_kind)?;
        }
        Ok(category_id)
    }

    pub(super) fn ensure_import_category(
        &self,
        reference: &str,
        expected_kind: &CategoryKind,
    ) -> Result<i64, AppError> {
        let trimmed = normalize_name("category", reference)?;
        let existing = self
            .conn
            .query_row(
                "SELECT id, kind, archived
                 FROM categories
                 WHERE name = ?1 COLLATE NOCASE",
                params![trimmed],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? == 1,
                    ))
                },
            )
            .optional()?;

        match existing {
            Some((category_id, actual_kind, archived)) => {
                validate_category_kind(expected_kind, &actual_kind)?;
                if archived {
                    self.conn.execute(
                        "UPDATE categories SET archived = 0 WHERE id = ?1",
                        params![category_id],
                    )?;
                }
                Ok(category_id)
            }
            None => self.add_category(&trimmed, expected_kind),
        }
    }
}
