use super::*;
use crate::model::{
    ComparisonVarianceRecord, DebtItemProjection, DebtMonthProjection, DebtStrategyProjection,
    RulePreviewRecord, SeasonalityRecord, TaxDeductionRecord, TaxDividendRecord, TaxGainRecord,
};
use chrono::Months;

impl Db {
    pub(super) fn apply_rules_to_import(
        &self,
        mut transaction: ResolvedTransaction,
        rules: &[TransactionRuleRecord],
    ) -> Result<(ResolvedTransaction, Vec<String>), AppError> {
        let mut tags = Vec::new();
        for rule in rules {
            if rule
                .account_id
                .is_some_and(|value| value != transaction.account_id)
                || rule
                    .kind
                    .as_deref()
                    .is_some_and(|value| value != transaction.kind.as_db_str())
                || rule
                    .min_amount_cents
                    .is_some_and(|value| transaction.amount_cents < value)
                || rule
                    .max_amount_cents
                    .is_some_and(|value| transaction.amount_cents > value)
            {
                continue;
            }
            let field = if rule.match_field == "note" {
                transaction.note.as_deref().unwrap_or("")
            } else {
                transaction.payee.as_deref().unwrap_or("")
            };
            if !text_matches(field, &rule.match_operator, &rule.match_value) {
                continue;
            }
            if let Some(value) = &rule.set_payee {
                transaction.payee = Some(value.clone());
            }
            if let Some(value) = rule.set_category_id {
                transaction.category_id = Some(value);
            }
            if let Some(value) = &rule.append_note {
                transaction.note = append_note_once(transaction.note, value);
            }
            for tag in &rule.tags {
                if !tags
                    .iter()
                    .any(|value: &String| value.eq_ignore_ascii_case(tag))
                {
                    tags.push(tag.clone());
                }
            }
            if rule.stop_processing {
                break;
            }
        }
        self.validate_resolved_transaction(&transaction)?;
        Ok((transaction, tags))
    }

    pub fn list_transaction_splits(
        &self,
        transaction_id: i64,
    ) -> Result<Vec<TransactionSplitRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT s.id,s.transaction_id,s.line_number,s.category_id,c.name,
                    s.amount_cents,s.reporting_amount_cents,s.memo
             FROM transaction_splits s JOIN categories c ON c.id=s.category_id
             WHERE s.transaction_id=?1 ORDER BY s.line_number",
        )?;
        let rows = statement.query_map(params![transaction_id], |row| {
            Ok(TransactionSplitRecord {
                id: row.get(0)?,
                transaction_id: row.get(1)?,
                line_number: row.get(2)?,
                category_id: row.get(3)?,
                category_name: row.get(4)?,
                amount_cents: row.get(5)?,
                reporting_amount_cents: row.get(6)?,
                memo: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_transaction_splits(
        &self,
        transaction_id: i64,
        inputs: &[TransactionSplitInput],
    ) -> Result<Vec<TransactionSplitRecord>, AppError> {
        let (kind, amount, reporting, deleted): (String, i64, i64, Option<String>) = self.conn
            .query_row(
                "SELECT kind,amount_cents,reporting_amount_cents,deleted_at FROM transactions WHERE id=?1",
                params![transaction_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            ).optional()?.ok_or_else(|| AppError::NotFound(format!("transaction `{transaction_id}` was not found")))?;
        if deleted.is_some() {
            return Err(AppError::Validation(
                "deleted transactions must be restored before splits can be edited".into(),
            ));
        }
        if self.transaction_has_reconciliations(transaction_id)? {
            return Err(AppError::Validation(
                "reconciled transactions cannot be split until the reconciliation is removed"
                    .into(),
            ));
        }
        if kind == "transfer" {
            return Err(AppError::Validation(
                "transfers cannot have category splits".into(),
            ));
        }
        if !inputs.is_empty() && inputs.len() < 2 {
            return Err(AppError::Validation(
                "a split transaction needs at least two category lines".into(),
            ));
        }
        if inputs.is_empty() {
            self.conn.execute(
                "DELETE FROM transaction_splits WHERE transaction_id=?1",
                params![transaction_id],
            )?;
            return Ok(Vec::new());
        }
        let expected_kind = if kind == "income" {
            CategoryKind::Income
        } else {
            CategoryKind::Expense
        };
        let mut resolved = Vec::with_capacity(inputs.len());
        let mut native_total = 0_i64;
        let explicit_reporting = inputs
            .iter()
            .all(|line| line.reporting_amount_cents.is_some());
        if inputs
            .iter()
            .any(|line| line.reporting_amount_cents.is_some())
            && !explicit_reporting
        {
            return Err(AppError::Validation(
                "provide reporting amounts for every split line or leave all of them blank".into(),
            ));
        }
        for line in inputs {
            if line.amount_cents <= 0 {
                return Err(AppError::Validation(
                    "split amounts must be positive".into(),
                ));
            }
            native_total = native_total
                .checked_add(line.amount_cents)
                .ok_or_else(|| AppError::Validation("split total is too large".into()))?;
            let category_id = self.resolve_category_ref(&line.category, Some(&expected_kind))?;
            resolved.push((
                category_id,
                line.amount_cents,
                line.reporting_amount_cents,
                normalize_optional_text(&line.memo),
            ));
        }
        if native_total != amount {
            return Err(AppError::Validation(format!(
                "split amounts must total the transaction amount (expected {}, got {})",
                amount, native_total
            )));
        }
        let reporting_lines = if explicit_reporting {
            let values = resolved
                .iter()
                .map(|line| line.2.unwrap_or(0))
                .collect::<Vec<_>>();
            let total = values.iter().try_fold(0_i64, |sum, value| {
                sum.checked_add(*value).ok_or_else(|| {
                    AppError::Validation("split reporting total is too large".into())
                })
            })?;
            if values.iter().any(|value| *value < 0) || total != reporting {
                return Err(AppError::Validation(format!(
                    "split reporting amounts must be non-negative and total {reporting}"
                )));
            }
            values
        } else {
            allocate_exact(
                reporting,
                &resolved.iter().map(|line| line.1).collect::<Vec<_>>(),
                amount,
            )?
        };
        self.conn.execute(
            "DELETE FROM transaction_splits WHERE transaction_id=?1",
            params![transaction_id],
        )?;
        for (index, ((category_id, native, _, memo), report)) in
            resolved.iter().zip(reporting_lines.iter()).enumerate()
        {
            self.conn.execute(
                "INSERT INTO transaction_splits(transaction_id,line_number,category_id,amount_cents,reporting_amount_cents,memo)
                 VALUES(?1,?2,?3,?4,?5,?6)",
                params![transaction_id,index as i64+1,category_id,native,report,memo],
            )?;
        }
        // The first category remains on the parent for old views and exports. Split-aware
        // reports always use the child lines and therefore never count it twice.
        self.conn.execute(
            "UPDATE transactions SET category_id=?1,updated_at=?2 WHERE id=?3",
            params![resolved[0].0, now_timestamp(), transaction_id],
        )?;
        self.list_transaction_splits(transaction_id)
    }

    pub fn validate_transaction_splits(&self, transaction_id: i64) -> Result<(), AppError> {
        let (count, native, reporting): (i64, i64, i64) = self.conn.query_row(
            "SELECT COUNT(*),COALESCE(SUM(amount_cents),0),COALESCE(SUM(reporting_amount_cents),0)
             FROM transaction_splits WHERE transaction_id=?1",
            params![transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if count == 0 {
            return Ok(());
        }
        let parent: (String, i64, i64) = self.conn.query_row(
            "SELECT kind,amount_cents,reporting_amount_cents FROM transactions WHERE id=?1",
            params![transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if parent.0 == "transfer" || count < 2 || native != parent.1 || reporting != parent.2 {
            return Err(AppError::Validation(
                "transaction split totals no longer match the parent transaction".into(),
            ));
        }
        let incompatible: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM transaction_splits s JOIN categories c ON c.id=s.category_id
             WHERE s.transaction_id=?1 AND c.kind!=?2",
            params![transaction_id, parent.0],
            |row| row.get(0),
        )?;
        if incompatible > 0 {
            return Err(AppError::Validation(
                "split categories must match the transaction kind".into(),
            ));
        }
        Ok(())
    }

    pub fn list_transaction_rules(&self) -> Result<Vec<TransactionRuleRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT r.id,r.name,r.priority,r.enabled,r.match_field,r.match_operator,r.match_value,
                    r.account_id,a.name,r.kind,r.min_amount_cents,r.max_amount_cents,r.set_payee,
                    r.set_category_id,c.name,r.append_note,r.stop_processing
             FROM transaction_rules r LEFT JOIN accounts a ON a.id=r.account_id
             LEFT JOIN categories c ON c.id=r.set_category_id ORDER BY r.priority,r.id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(TransactionRuleRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    priority: row.get(2)?,
                    enabled: row.get::<_, i64>(3)? == 1,
                    match_field: row.get(4)?,
                    match_operator: row.get(5)?,
                    match_value: row.get(6)?,
                    account_id: row.get(7)?,
                    account_name: row.get(8)?,
                    kind: row.get(9)?,
                    min_amount_cents: row.get(10)?,
                    max_amount_cents: row.get(11)?,
                    set_payee: row.get(12)?,
                    set_category_id: row.get(13)?,
                    set_category_name: row.get(14)?,
                    append_note: row.get(15)?,
                    tags: Vec::new(),
                    stop_processing: row.get::<_, i64>(16)? == 1,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut result = rows;
        for rule in &mut result {
            let mut tags=self.conn.prepare("SELECT t.name FROM transaction_rule_tags rt JOIN tags t ON t.id=rt.tag_id WHERE rt.rule_id=?1 ORDER BY t.name COLLATE NOCASE")?;
            rule.tags = tags
                .query_map(params![rule.id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
        }
        Ok(result)
    }

    pub fn save_transaction_rule(
        &self,
        id: Option<i64>,
        input: &TransactionRuleInput,
    ) -> Result<i64, AppError> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("rule name cannot be empty".into()));
        }
        if input.priority < 0 {
            return Err(AppError::Validation(
                "rule priority cannot be negative".into(),
            ));
        }
        if !matches!(input.match_field.as_str(), "payee" | "note") {
            return Err(AppError::Validation(
                "rule match field must be payee or note".into(),
            ));
        }
        if !matches!(
            input.match_operator.as_str(),
            "contains" | "exact" | "starts_with" | "ends_with"
        ) {
            return Err(AppError::Validation("invalid rule match operator".into()));
        }
        let match_value = input.match_value.trim();
        if match_value.is_empty() {
            return Err(AppError::Validation(
                "rule match value cannot be empty".into(),
            ));
        }
        if input.min_amount_cents.is_some_and(|v| v <= 0)
            || input.max_amount_cents.is_some_and(|v| v <= 0)
            || matches!((input.min_amount_cents,input.max_amount_cents),(Some(a),Some(b)) if a>b)
        {
            return Err(AppError::Validation("rule amount range is invalid".into()));
        }
        let account_id = input
            .account
            .as_deref()
            .map(|v| self.resolve_account_ref(v))
            .transpose()?;
        if input.set_category.is_some() && input.kind.is_none() {
            return Err(AppError::Validation(
                "a category action requires an income or expense rule kind".into(),
            ));
        }
        let expected_kind = input.kind.and_then(expected_category_kind);
        let category_id = input
            .set_category
            .as_deref()
            .map(|v| self.resolve_category_ref(v, expected_kind.as_ref()))
            .transpose()?;
        if input
            .set_payee
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
            && category_id.is_none()
            && input
                .append_note
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .is_none()
            && input.tags.iter().all(|v| v.trim().is_empty())
        {
            return Err(AppError::Validation(
                "a rule needs at least one action".into(),
            ));
        }
        let now = now_timestamp();
        let rule_id = if let Some(id) = id {
            let changed=self.conn.execute("UPDATE transaction_rules SET name=?1,priority=?2,enabled=?3,match_field=?4,match_operator=?5,match_value=?6,account_id=?7,kind=?8,min_amount_cents=?9,max_amount_cents=?10,set_payee=?11,set_category_id=?12,append_note=?13,stop_processing=?14,updated_at=?15 WHERE id=?16",
                params![name,input.priority,input.enabled as i64,input.match_field,input.match_operator,match_value,account_id,input.kind.map(|v|v.as_db_str()),input.min_amount_cents,input.max_amount_cents,normalize_optional_text(&input.set_payee),category_id,normalize_optional_text(&input.append_note),input.stop_processing as i64,now,id])?;
            if changed == 0 {
                return Err(AppError::NotFound(format!(
                    "transaction rule `{id}` was not found"
                )));
            }
            id
        } else {
            self.conn.execute("INSERT INTO transaction_rules(name,priority,enabled,match_field,match_operator,match_value,account_id,kind,min_amount_cents,max_amount_cents,set_payee,set_category_id,append_note,stop_processing,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)",
                params![name,input.priority,input.enabled as i64,input.match_field,input.match_operator,match_value,account_id,input.kind.map(|v|v.as_db_str()),input.min_amount_cents,input.max_amount_cents,normalize_optional_text(&input.set_payee),category_id,normalize_optional_text(&input.append_note),input.stop_processing as i64,now])?;
            self.conn.last_insert_rowid()
        };
        self.conn.execute(
            "DELETE FROM transaction_rule_tags WHERE rule_id=?1",
            params![rule_id],
        )?;
        for tag in &input.tags {
            if !tag.trim().is_empty() {
                let name = normalize_name("tag", tag)?;
                self.conn
                    .execute("INSERT OR IGNORE INTO tags(name) VALUES(?1)", params![name])?;
                let tag_id = self.conn.query_row(
                    "SELECT id FROM tags WHERE name=?1",
                    params![name],
                    |row| row.get::<_, i64>(0),
                )?;
                self.conn.execute(
                    "INSERT OR IGNORE INTO transaction_rule_tags(rule_id,tag_id) VALUES(?1,?2)",
                    params![rule_id, tag_id],
                )?;
            }
        }
        Ok(rule_id)
    }

    pub fn delete_transaction_rule(&self, id: i64) -> Result<(), AppError> {
        if self
            .conn
            .execute("DELETE FROM transaction_rules WHERE id=?1", params![id])?
            == 0
        {
            return Err(AppError::NotFound(format!(
                "transaction rule `{id}` was not found"
            )));
        }
        Ok(())
    }

    pub fn apply_transaction_rules(
        &self,
        transaction_ids: Option<&[i64]>,
        dry_run: bool,
    ) -> Result<RuleApplyResult, AppError> {
        let rules = self
            .list_transaction_rules()?
            .into_iter()
            .filter(|r| r.enabled)
            .collect::<Vec<_>>();
        let mut sql="SELECT t.id,t.txn_date,t.kind,t.amount_cents,t.account_id,t.category_id,c.name,t.payee,t.note,EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id) FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.deleted_at IS NULL AND t.kind IN ('income','expense')".to_string();
        let ids = transaction_ids.unwrap_or(&[]);
        if !ids.is_empty() {
            sql.push_str(&format!(
                " AND t.id IN ({})",
                std::iter::repeat("?")
                    .take(ids.len())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        sql.push_str(" ORDER BY t.txn_date,t.id");
        let mut stmt = self.conn.prepare(&sql)?;
        let params = ids
            .iter()
            .copied()
            .map(rusqlite::types::Value::Integer)
            .collect::<Vec<_>>();
        let txs = stmt
            .query_map(rusqlite::params_from_iter(params), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)? == 1,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut preview = Vec::new();
        let mut skipped = 0usize;
        for (
            id,
            date,
            kind,
            amount,
            account,
            category_id,
            category_name,
            payee,
            note,
            has_splits,
        ) in txs
        {
            if self.transaction_has_reconciliations(id)? {
                skipped += 1;
                continue;
            }
            let mut after_payee = payee.clone();
            let mut after_category_id = category_id;
            let mut after_category = category_name.clone();
            let mut after_note = note.clone();
            let mut matched = Vec::new();
            let mut added_tags = Vec::new();
            for rule in &rules {
                if rule.account_id.is_some_and(|v| v != account)
                    || rule.kind.as_deref().is_some_and(|v| v != kind)
                    || rule.min_amount_cents.is_some_and(|v| amount < v)
                    || rule.max_amount_cents.is_some_and(|v| amount > v)
                {
                    continue;
                }
                let field = if rule.match_field == "note" {
                    after_note.as_deref().unwrap_or("")
                } else {
                    after_payee.as_deref().unwrap_or("")
                };
                if !text_matches(field, &rule.match_operator, &rule.match_value) {
                    continue;
                }
                matched.push(rule.id);
                if let Some(v) = &rule.set_payee {
                    after_payee = Some(v.clone());
                }
                if let Some(v) = rule.set_category_id {
                    if !has_splits {
                        after_category_id = Some(v);
                        after_category = rule.set_category_name.clone();
                    }
                }
                if let Some(v) = &rule.append_note {
                    after_note = append_note_once(after_note, v);
                }
                for tag in &rule.tags {
                    if !added_tags
                        .iter()
                        .any(|v: &String| v.eq_ignore_ascii_case(tag))
                    {
                        added_tags.push(tag.clone());
                    }
                }
                if rule.stop_processing {
                    break;
                }
            }
            if matched.is_empty() {
                continue;
            }
            let existing_tag_names = self
                .list_transaction_tags(id)?
                .into_iter()
                .map(|v| v.name)
                .collect::<Vec<_>>();
            added_tags.retain(|tag| {
                !existing_tag_names
                    .iter()
                    .any(|v| v.eq_ignore_ascii_case(tag))
            });
            if after_payee == payee
                && after_category_id == category_id
                && after_note == note
                && added_tags.is_empty()
            {
                continue;
            }
            preview.push(RulePreviewRecord {
                transaction_id: id,
                txn_date: date,
                matched_rule_ids: matched,
                before_payee: payee.clone(),
                after_payee: after_payee.clone(),
                before_category: category_name,
                after_category: after_category.clone(),
                before_note: note.clone(),
                after_note: after_note.clone(),
                added_tags: added_tags.clone(),
            });
        }
        if dry_run || preview.is_empty() {
            return Ok(RuleApplyResult {
                run_id: None,
                changed_count: preview.len(),
                skipped_reconciled_count: skipped,
                preview,
            });
        }
        let now = now_timestamp();
        self.conn.execute(
            "INSERT INTO rule_application_runs(created_at) VALUES(?1)",
            params![now],
        )?;
        let run_id = self.conn.last_insert_rowid();
        for change in &preview {
            let row: (Option<i64>, Option<String>, Option<String>) = self.conn.query_row(
                "SELECT category_id,payee,note FROM transactions WHERE id=?1",
                params![change.transaction_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let tag_ids = self.transaction_tag_ids(change.transaction_id)?;
            self.conn.execute("INSERT INTO rule_application_changes(run_id,transaction_id,previous_payee,previous_category_id,previous_note,previous_tag_ids) VALUES(?1,?2,?3,?4,?5,?6)",params![run_id,change.transaction_id,row.1,row.0,row.2,serde_json::to_string(&tag_ids).map_err(|e|AppError::Config(e.to_string()))?])?;
            let category_id = change
                .after_category
                .as_deref()
                .map(|v| self.resolve_category_ref(v, None))
                .transpose()?;
            self.conn.execute("UPDATE transactions SET payee=?1,category_id=COALESCE(?2,category_id),note=?3,updated_at=?4 WHERE id=?5",params![change.after_payee,category_id,change.after_note,now,change.transaction_id])?;
            for tag in &change.added_tags {
                self.add_transaction_tag(change.transaction_id, tag)?;
            }
        }
        Ok(RuleApplyResult {
            run_id: Some(run_id),
            changed_count: preview.len(),
            skipped_reconciled_count: skipped,
            preview,
        })
    }

    pub fn undo_rule_application(&self, run_id: i64) -> Result<usize, AppError> {
        let undone: Option<String> = self
            .conn
            .query_row(
                "SELECT undone_at FROM rule_application_runs WHERE id=?1",
                params![run_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                AppError::NotFound(format!("rule application run `{run_id}` was not found"))
            })?;
        if undone.is_some() {
            return Err(AppError::Validation(
                "this rule application was already undone".into(),
            ));
        }
        let mut stmt=self.conn.prepare("SELECT transaction_id,previous_payee,previous_category_id,previous_note,previous_tag_ids FROM rule_application_changes WHERE run_id=?1 ORDER BY transaction_id")?;
        let rows = stmt
            .query_map(params![run_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, _, _, _, _) in &rows {
            if self.transaction_has_reconciliations(*id)? {
                return Err(AppError::Validation(format!("transaction `{id}` is now reconciled; remove that reconciliation before undoing the rule run")));
            }
        }
        let now = now_timestamp();
        for (id, payee, category, note, tags) in &rows {
            self.conn.execute(
                "UPDATE transactions SET payee=?1,category_id=?2,note=?3,updated_at=?4 WHERE id=?5",
                params![payee, category, note, now, id],
            )?;
            self.conn.execute(
                "DELETE FROM transaction_tags WHERE transaction_id=?1",
                params![id],
            )?;
            let ids: Vec<i64> = serde_json::from_str(tags)
                .map_err(|e| AppError::Config(format!("invalid saved rule undo data: {e}")))?;
            for tag_id in ids {
                self.conn.execute(
                    "INSERT INTO transaction_tags(transaction_id,tag_id) VALUES(?1,?2)",
                    params![id, tag_id],
                )?;
            }
        }
        self.conn.execute(
            "UPDATE rule_application_runs SET undone_at=?1 WHERE id=?2",
            params![now, run_id],
        )?;
        Ok(rows.len())
    }

    pub fn save_credit_debt_settings(
        &self,
        account_ref: &str,
        annual_rate_bps: i64,
        minimum_payment_cents: i64,
    ) -> Result<(), AppError> {
        let account_id = self.resolve_account_ref(account_ref)?;
        let kind: String = self.conn.query_row(
            "SELECT kind FROM accounts WHERE id=?1",
            params![account_id],
            |r| r.get(0),
        )?;
        if kind != "credit" {
            return Err(AppError::Validation(
                "debt settings can only be saved for credit accounts".into(),
            ));
        }
        if !(0..=100_000).contains(&annual_rate_bps) || minimum_payment_cents <= 0 {
            return Err(AppError::Validation(
                "credit APR or minimum payment is invalid".into(),
            ));
        }
        self.conn.execute("INSERT INTO debt_account_settings(account_id,annual_rate_bps,minimum_payment_cents,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(account_id) DO UPDATE SET annual_rate_bps=excluded.annual_rate_bps,minimum_payment_cents=excluded.minimum_payment_cents,updated_at=excluded.updated_at",params![account_id,annual_rate_bps,minimum_payment_cents,now_timestamp()])?;
        Ok(())
    }

    pub fn delete_credit_debt_settings(&self, account_ref: &str) -> Result<(), AppError> {
        let account_id = self.resolve_account_ref(account_ref)?;
        self.conn.execute(
            "DELETE FROM debt_account_settings WHERE account_id=?1",
            params![account_id],
        )?;
        Ok(())
    }

    pub fn debt_optimizer(
        &self,
        extra_payment_cents: i64,
    ) -> Result<DebtOptimizerSnapshot, AppError> {
        if extra_payment_cents < 0 {
            return Err(AppError::Validation(
                "extra debt payment cannot be negative".into(),
            ));
        }
        let mut debts = Vec::<DebtSeed>::new();
        let mut loans=self.conn.prepare("SELECT id,name,outstanding_cents,COALESCE(annual_rate_bps,0),emi_cents FROM loans WHERE outstanding_cents>0 ORDER BY id")?;
        for row in loans.query_map([], |r| {
            Ok(DebtSeed {
                key: format!("loan:{}", r.get::<_, i64>(0)?),
                name: r.get(1)?,
                source: "loan".into(),
                balance: r.get(2)?,
                rate_bps: r.get(3)?,
                minimum: r.get(4)?,
            })
        })? {
            debts.push(row?);
        }
        let as_of = Local::now().date_naive();
        let reporting_currency = self.currency_code()?;
        for balance in self.balances(None)? {
            if balance.account_kind == AccountKind::Credit && balance.current_balance_cents < 0 {
                let settings:Option<(i64,i64)>=self.conn.query_row("SELECT annual_rate_bps,minimum_payment_cents FROM debt_account_settings WHERE account_id=?1",params![balance.account_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((rate, minimum)) = settings {
                    let reporting_balance = if balance.currency_code == reporting_currency {
                        balance.current_balance_cents
                    } else {
                        self.reporting_value(
                            balance.current_balance_cents,
                            &balance.currency_code,
                            &as_of.to_string(),
                        )?
                    };
                    debts.push(DebtSeed {
                        key: format!("account:{}", balance.account_id),
                        name: balance.account_name,
                        source: "credit".into(),
                        balance: -reporting_balance,
                        rate_bps: rate,
                        minimum,
                    });
                }
            }
        }
        Ok(DebtOptimizerSnapshot {
            as_of: as_of.to_string(),
            extra_payment_cents,
            avalanche: simulate_debts(&debts, extra_payment_cents, "avalanche", as_of)?,
            snowball: simulate_debts(&debts, extra_payment_cents, "snowball", as_of)?,
        })
    }

    pub fn list_credit_debt_settings(&self) -> Result<Vec<DebtAccountSettingRecord>, AppError> {
        let mut statement=self.conn.prepare("SELECT d.account_id,a.name,d.annual_rate_bps,d.minimum_payment_cents FROM debt_account_settings d JOIN accounts a ON a.id=d.account_id WHERE a.archived=0 ORDER BY a.name COLLATE NOCASE")?;
        let rows = statement.query_map([], |row| {
            Ok(DebtAccountSettingRecord {
                account_id: row.get(0)?,
                account_name: row.get(1)?,
                annual_rate_bps: row.get(2)?,
                minimum_payment_cents: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_investment_tax_treatment(
        &self,
        account_id: i64,
        treatment: &str,
    ) -> Result<(), AppError> {
        let exists = self.conn.query_row(
            "SELECT COUNT(*) FROM investment_accounts WHERE id=?1",
            params![account_id],
            |row| row.get::<_, i64>(0),
        )?;
        if exists == 0 {
            return Err(AppError::NotFound(format!(
                "investment account `{account_id}` was not found"
            )));
        }
        if !matches!(treatment, "taxable" | "tax_advantaged" | "unknown") {
            return Err(AppError::Validation(
                "tax treatment must be taxable, tax_advantaged, or unknown".into(),
            ));
        }
        self.conn.execute("INSERT INTO investment_tax_settings(investment_account_id,treatment,updated_at) VALUES(?1,?2,?3) ON CONFLICT(investment_account_id) DO UPDATE SET treatment=excluded.treatment,updated_at=excluded.updated_at",params![account_id,treatment,now_timestamp()])?;
        Ok(())
    }

    pub fn list_investment_tax_settings(
        &self,
    ) -> Result<Vec<InvestmentTaxSettingRecord>, AppError> {
        let mut statement=self.conn.prepare("SELECT investment_account_id,treatment FROM investment_tax_settings ORDER BY investment_account_id")?;
        let rows = statement.query_map([], |row| {
            Ok(InvestmentTaxSettingRecord {
                investment_account_id: row.get(0)?,
                treatment: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_tax_category(
        &self,
        category_ref: &str,
        group: Option<&str>,
    ) -> Result<(), AppError> {
        let id = self.resolve_category_ref(category_ref, Some(&CategoryKind::Expense))?;
        match group.map(str::trim).filter(|v| !v.is_empty()) {
            Some(group) => {
                self.conn.execute("INSERT INTO tax_category_settings(category_id,deduction_group,updated_at) VALUES(?1,?2,?3) ON CONFLICT(category_id) DO UPDATE SET deduction_group=excluded.deduction_group,updated_at=excluded.updated_at",params![id,group,now_timestamp()])?;
            }
            None => {
                self.conn.execute(
                    "DELETE FROM tax_category_settings WHERE category_id=?1",
                    params![id],
                )?;
            }
        }
        Ok(())
    }

    pub fn list_tax_category_settings(&self) -> Result<Vec<TaxCategorySettingRecord>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT category_id,deduction_group FROM tax_category_settings ORDER BY category_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(TaxCategorySettingRecord {
                category_id: row.get(0)?,
                deduction_group: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn tax_center(&self, tax_year: i32) -> Result<TaxCenterSnapshot, AppError> {
        if !(1900..=9999).contains(&tax_year) {
            return Err(AppError::Validation(
                "tax year must be between 1900 and 9999".into(),
            ));
        }
        let from = format!("{tax_year:04}-01-01");
        let to = format!("{tax_year:04}-12-31");
        let mut gains = Vec::new();
        let mut keys=self.conn.prepare("SELECT DISTINCT l.investment_account_id,l.security_id,ia.name,s.symbol,COALESCE(ts.treatment,'unknown') FROM holdings_lots l JOIN investment_accounts ia ON ia.id=l.investment_account_id JOIN securities s ON s.id=l.security_id LEFT JOIN investment_tax_settings ts ON ts.investment_account_id=l.investment_account_id ORDER BY l.investment_account_id,l.security_id")?;
        let keys = keys
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (account_id, security_id, account_name, symbol, treatment) in keys {
            let mut lot_stmt=self.conn.prepare("SELECT quantity_micros,reporting_buy_price_cents,bought_on FROM holdings_lots WHERE investment_account_id=?1 AND security_id=?2 ORDER BY bought_on,id")?;
            let mut lots = lot_stmt
                .query_map(params![account_id, security_id], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut sale_stmt=self.conn.prepare("SELECT event_on,quantity_micros,reporting_price_cents FROM holding_events WHERE investment_account_id=?1 AND security_id=?2 AND event_type='sell' ORDER BY event_on,id")?;
            let sales = sale_stmt
                .query_map(params![account_id, security_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut lot_index = 0usize;
            for (sold_on, quantity, sale_price) in sales {
                let mut remaining = quantity;
                let total_proceeds = minor_value(quantity, sale_price)?;
                let mut allocated = 0_i64;
                while remaining > 0 {
                    while lot_index < lots.len() && lots[lot_index].0 == 0 {
                        lot_index += 1;
                    }
                    if lot_index >= lots.len() {
                        return Err(AppError::Config("sale quantity exceeds FIFO lots".into()));
                    }
                    if lots[lot_index].2 > sold_on {
                        return Err(AppError::Config(
                            "sale precedes the FIFO purchase lot".into(),
                        ));
                    }
                    let used = remaining.min(lots[lot_index].0);
                    let proceeds = if used == remaining {
                        total_proceeds - allocated
                    } else {
                        minor_value(used, sale_price)?
                    };
                    allocated += proceeds;
                    let cost = minor_value(used, lots[lot_index].1)?;
                    if sold_on >= from && sold_on <= to {
                        let bought = lots[lot_index].2.clone();
                        let term = if is_long_term(&bought, &sold_on)? {
                            "long_term"
                        } else {
                            "short_term"
                        };
                        gains.push(TaxGainRecord {
                            investment_account_id: account_id,
                            investment_account_name: account_name.clone(),
                            treatment: treatment.clone(),
                            security_symbol: symbol.clone(),
                            sold_on: sold_on.clone(),
                            bought_on: bought,
                            quantity_micros: used,
                            proceeds_cents: proceeds,
                            cost_basis_cents: cost,
                            gain_cents: proceeds.checked_sub(cost).ok_or_else(|| {
                                AppError::Validation("realized gain is too large".into())
                            })?,
                            term: term.into(),
                        });
                    }
                    lots[lot_index].0 -= used;
                    remaining -= used;
                }
            }
        }
        let mut dividends = Vec::new();
        let mut div_stmt=self.conn.prepare("SELECT COALESCE(ts.treatment,'unknown'),COALESCE(SUM(e.reporting_amount_cents),0) FROM holding_events e LEFT JOIN investment_tax_settings ts ON ts.investment_account_id=e.investment_account_id WHERE e.event_type='dividend' AND e.event_on BETWEEN ?1 AND ?2 GROUP BY COALESCE(ts.treatment,'unknown') ORDER BY 1")?;
        for row in div_stmt.query_map(params![from, to], |r| {
            Ok(TaxDividendRecord {
                treatment: r.get(0)?,
                amount_cents: r.get(1)?,
            })
        })? {
            dividends.push(row?);
        }
        let mut deductions = Vec::new();
        let mut ded_stmt=self.conn.prepare("WITH allocations AS (SELECT t.id transaction_id,t.category_id,t.reporting_amount_cents amount FROM transactions t WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.txn_date BETWEEN ?1 AND ?2 AND NOT EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id) UNION ALL SELECT t.id,s.category_id,s.reporting_amount_cents FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.txn_date BETWEEN ?1 AND ?2) SELECT tc.deduction_group,SUM(a.amount),COUNT(DISTINCT a.transaction_id) FROM allocations a JOIN tax_category_settings tc ON tc.category_id=a.category_id GROUP BY tc.deduction_group ORDER BY tc.deduction_group COLLATE NOCASE")?;
        for row in ded_stmt.query_map(params![from, to], |r| {
            Ok(TaxDeductionRecord {
                group: r.get(0)?,
                amount_cents: r.get(1)?,
                transaction_count: r.get(2)?,
            })
        })? {
            deductions.push(row?);
        }
        let proceeds = checked_total(gains.iter().map(|v| v.proceeds_cents), "sale proceeds")?;
        let basis = checked_total(gains.iter().map(|v| v.cost_basis_cents), "cost basis")?;
        let short = checked_total(
            gains
                .iter()
                .filter(|v| v.term == "short_term")
                .map(|v| v.gain_cents),
            "short-term gain",
        )?;
        let long = checked_total(
            gains
                .iter()
                .filter(|v| v.term == "long_term")
                .map(|v| v.gain_cents),
            "long-term gain",
        )?;
        let unknown=self.conn.query_row("SELECT COUNT(*) FROM investment_accounts ia LEFT JOIN investment_tax_settings ts ON ts.investment_account_id=ia.id WHERE ts.treatment IS NULL OR ts.treatment='unknown'",[],|r|r.get::<_,i64>(0))?;
        let mut warnings=vec!["Tax summaries are preparation aids; tax treatment and deductible eligibility depend on your jurisdiction and circumstances.".into()];
        if unknown > 0 {
            warnings.push(format!(
                "{unknown} investment account(s) have unknown tax treatment."
            ));
        }
        Ok(TaxCenterSnapshot {
            tax_year,
            realized_proceeds_cents: proceeds,
            realized_cost_basis_cents: basis,
            short_term_gain_cents: short,
            long_term_gain_cents: long,
            gains,
            dividends,
            deductions,
            warnings,
        })
    }

    pub fn comparative_analytics(
        &self,
        current_from: &str,
        current_to: &str,
        baseline_from: &str,
        baseline_to: &str,
        account: Option<&str>,
    ) -> Result<ComparativeAnalyticsSnapshot, AppError> {
        let current_from = normalize_date_value(current_from)?;
        let current_to = normalize_date_value(current_to)?;
        let baseline_from = normalize_date_value(baseline_from)?;
        let baseline_to = normalize_date_value(baseline_to)?;
        if current_from > current_to || baseline_from > baseline_to {
            return Err(AppError::Validation(
                "comparison start dates must not be after end dates".into(),
            ));
        }
        let current = self.summary(&current_from, &current_to, account)?;
        let baseline = self.summary(&baseline_from, &baseline_to, account)?;
        let account_id = account.map(|v| self.resolve_account_ref(v)).transpose()?;
        let current_rows = self.comparison_dimension(&current_from, &current_to, account_id)?;
        let baseline_rows = self.comparison_dimension(&baseline_from, &baseline_to, account_id)?;
        let mut labels = BTreeMap::<(String, String), (i64, i64)>::new();
        for (d, l, v) in current_rows {
            labels.entry((d, l)).or_default().0 = v;
        }
        for (d, l, v) in baseline_rows {
            labels.entry((d, l)).or_default().1 = v;
        }
        let mut variances = labels
            .into_iter()
            .map(|((dimension, label), (a, b))| {
                let delta = a.checked_sub(b).ok_or_else(|| {
                    AppError::Validation("comparison variance is too large".into())
                })?;
                Ok(ComparisonVarianceRecord {
                    dimension,
                    label,
                    current_cents: a,
                    baseline_cents: b,
                    delta_cents: delta,
                    delta_percent: if b == 0 {
                        None
                    } else {
                        Some(delta as f64 / b.unsigned_abs() as f64 * 100.0)
                    },
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        variances.sort_by_key(|row| std::cmp::Reverse(row.delta_cents.unsigned_abs()));
        Ok(ComparativeAnalyticsSnapshot {
            current,
            baseline,
            variances,
            seasonality: self.expense_seasonality(account_id)?,
        })
    }

    fn comparison_dimension(
        &self,
        from: &str,
        to: &str,
        account_id: Option<i64>,
    ) -> Result<Vec<(String, String, i64)>, AppError> {
        let sql="WITH allocations AS (SELECT t.id,t.account_id,t.payee,t.category_id,CASE WHEN ?3 IS NULL THEN t.reporting_amount_cents ELSE t.amount_cents END amount FROM transactions t WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.txn_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR t.account_id=?3) AND NOT EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id) UNION ALL SELECT t.id,t.account_id,t.payee,s.category_id,CASE WHEN ?3 IS NULL THEN s.reporting_amount_cents ELSE s.amount_cents END FROM transactions t JOIN transaction_splits s ON s.transaction_id=t.id WHERE t.deleted_at IS NULL AND t.kind='expense' AND t.txn_date BETWEEN ?1 AND ?2 AND (?3 IS NULL OR t.account_id=?3)), dims AS (SELECT 'category' dimension,c.name label,SUM(x.amount) amount FROM allocations x JOIN categories c ON c.id=x.category_id GROUP BY c.id,c.name UNION ALL SELECT 'payee',COALESCE(NULLIF(TRIM(x.payee),''),'Unassigned'),SUM(x.amount) FROM allocations x GROUP BY COALESCE(NULLIF(TRIM(x.payee),''),'Unassigned') UNION ALL SELECT 'account',a.name,SUM(x.amount) FROM allocations x JOIN accounts a ON a.id=x.account_id GROUP BY a.id,a.name) SELECT dimension,label,amount FROM dims";
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params![from, to, account_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn expense_seasonality(
        &self,
        account_id: Option<i64>,
    ) -> Result<Vec<SeasonalityRecord>, AppError> {
        let bounds:(Option<String>,Option<String>)=self.conn.query_row("SELECT MIN(substr(txn_date,1,7)),MAX(substr(txn_date,1,7)) FROM transactions WHERE deleted_at IS NULL AND kind='expense' AND (?1 IS NULL OR account_id=?1)",params![account_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let (Some(first), Some(last)) = bounds else {
            return Ok(Vec::new());
        };
        let mut cursor = NaiveDate::parse_from_str(&format!("{first}-01"), "%Y-%m-%d")
            .map_err(|_| AppError::Config("invalid transaction month".into()))?;
        let end = NaiveDate::parse_from_str(&format!("{last}-01"), "%Y-%m-%d")
            .map_err(|_| AppError::Config("invalid transaction month".into()))?;
        let mut totals = [0_i64; 12];
        let mut counts = [0_usize; 12];
        let mut monthly = HashMap::<String, i64>::new();
        let mut stmt=self.conn.prepare("SELECT substr(txn_date,1,7),SUM(CASE WHEN ?1 IS NULL THEN reporting_amount_cents ELSE amount_cents END) FROM transactions WHERE deleted_at IS NULL AND kind='expense' AND (?1 IS NULL OR account_id=?1) GROUP BY substr(txn_date,1,7)")?;
        for row in stmt.query_map(params![account_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })? {
            let (k, v) = row?;
            monthly.insert(k, v);
        }
        while cursor <= end {
            let idx = cursor.month0() as usize;
            totals[idx] = totals[idx]
                .checked_add(
                    *monthly
                        .get(&cursor.format("%Y-%m").to_string())
                        .unwrap_or(&0),
                )
                .ok_or_else(|| AppError::Validation("seasonality total is too large".into()))?;
            counts[idx] += 1;
            cursor = cursor.checked_add_months(Months::new(1)).ok_or_else(|| {
                AppError::Validation("seasonality date range is too large".into())
            })?;
        }
        let averages = (0..12)
            .map(|i| {
                if counts[i] == 0 {
                    0
                } else {
                    totals[i] / counts[i] as i64
                }
            })
            .collect::<Vec<_>>();
        let observed_months = counts.iter().filter(|count| **count > 0).count();
        let overall = if observed_months > 0 {
            checked_total(averages.iter().copied(), "seasonality")? as f64 / observed_months as f64
        } else {
            0.0
        };
        Ok((0..12)
            .map(|i| SeasonalityRecord {
                month_number: i as u32 + 1,
                month_name: [
                    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov",
                    "Dec",
                ][i]
                    .into(),
                average_expense_cents: averages[i],
                index: if overall == 0.0 {
                    0.0
                } else {
                    averages[i] as f64 / overall
                },
                observation_count: counts[i],
            })
            .collect())
    }

    fn transaction_tag_ids(&self, id: i64) -> Result<Vec<i64>, AppError> {
        let mut stmt = self.conn.prepare(
            "SELECT tag_id FROM transaction_tags WHERE transaction_id=?1 ORDER BY tag_id",
        )?;
        let rows = stmt.query_map(params![id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}

#[derive(Clone)]
struct DebtSeed {
    key: String,
    name: String,
    source: String,
    balance: i64,
    rate_bps: i64,
    minimum: i64,
}
fn allocate_exact(total: i64, weights: &[i64], weight_total: i64) -> Result<Vec<i64>, AppError> {
    let denominator = weight_total as i128;
    let mut ranked = weights
        .iter()
        .enumerate()
        .map(|(index, weight)| {
            let product = (*weight as i128)
                .checked_mul(total as i128)
                .ok_or_else(|| AppError::Validation("split allocation is too large".into()))?;
            let base = i64::try_from(product / denominator)
                .map_err(|_| AppError::Validation("split allocation is too large".into()))?;
            Ok((index, base, product % denominator))
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let used = ranked.iter().map(|(_, base, _)| *base).sum::<i64>();
    let remainder = usize::try_from(total - used)
        .map_err(|_| AppError::Config("invalid split allocation remainder".into()))?;
    ranked.sort_by(|left, right| right.2.cmp(&left.2).then(left.0.cmp(&right.0)));
    for row in ranked.iter_mut().take(remainder) {
        row.1 += 1;
    }
    ranked.sort_by_key(|row| row.0);
    let out = ranked.into_iter().map(|(_, value, _)| value).collect();
    Ok(out)
}
fn text_matches(value: &str, operator: &str, needle: &str) -> bool {
    let value = value.to_lowercase();
    let needle = needle.to_lowercase();
    match operator {
        "exact" => value == needle,
        "starts_with" => value.starts_with(&needle),
        "ends_with" => value.ends_with(&needle),
        _ => value.contains(&needle),
    }
}
fn append_note_once(existing: Option<String>, addition: &str) -> Option<String> {
    match existing {
        Some(value)
            if value
                .lines()
                .any(|line| line.trim().eq_ignore_ascii_case(addition.trim())) =>
        {
            Some(value)
        }
        Some(value) if !value.trim().is_empty() => Some(format!("{value}\n{addition}")),
        _ => Some(addition.to_string()),
    }
}
fn checked_total(mut values: impl Iterator<Item = i64>, label: &str) -> Result<i64, AppError> {
    values.try_fold(0_i64, |sum, value| {
        sum.checked_add(value)
            .ok_or_else(|| AppError::Validation(format!("{label} total is too large")))
    })
}
fn minor_value(quantity: i64, price: i64) -> Result<i64, AppError> {
    let v = (quantity as i128)
        .checked_mul(price as i128)
        .ok_or_else(|| AppError::Validation("holding value is too large".into()))?;
    i64::try_from((v + 500_000) / 1_000_000)
        .map_err(|_| AppError::Validation("holding value is too large".into()))
}
fn is_long_term(bought: &str, sold: &str) -> Result<bool, AppError> {
    let b = NaiveDate::parse_from_str(bought, "%Y-%m-%d")
        .map_err(|_| AppError::Config("invalid holding lot date".into()))?;
    let s = NaiveDate::parse_from_str(sold, "%Y-%m-%d")
        .map_err(|_| AppError::Config("invalid holding sale date".into()))?;
    let anniversary = b
        .checked_add_months(Months::new(12))
        .ok_or_else(|| AppError::Validation("holding date is out of range".into()))?;
    Ok(s > anniversary)
}
fn rounded_interest(balance: i64, bps: i64) -> Result<i64, AppError> {
    let n = (balance as i128)
        .checked_mul(bps as i128)
        .ok_or_else(|| AppError::Validation("debt interest is too large".into()))?;
    i64::try_from((n + 60_000) / 120_000)
        .map_err(|_| AppError::Validation("debt interest is too large".into()))
}
fn simulate_debts(
    seeds: &[DebtSeed],
    extra: i64,
    strategy: &str,
    as_of: NaiveDate,
) -> Result<DebtStrategyProjection, AppError> {
    let mut states = seeds
        .iter()
        .map(|s| (s.clone(), s.balance, 0_i64, None))
        .collect::<Vec<_>>();
    let monthly_budget = seeds.iter().try_fold(extra, |sum, s| {
        sum.checked_add(s.minimum)
            .ok_or_else(|| AppError::Validation("monthly debt budget is too large".into()))
    })?;
    let mut months = Vec::new();
    let mut warnings = Vec::new();
    let mut total_paid = 0_i64;
    for step in 1..=1200 {
        if states.iter().all(|v| v.1 == 0) {
            break;
        }
        let mut interest_month = 0_i64;
        for state in &mut states {
            if state.1 > 0 {
                let interest = rounded_interest(state.1, state.0.rate_bps)?;
                state.1 = state
                    .1
                    .checked_add(interest)
                    .ok_or_else(|| AppError::Validation("debt balance is too large".into()))?;
                state.2 = state.2.checked_add(interest).ok_or_else(|| {
                    AppError::Validation("debt interest total is too large".into())
                })?;
                interest_month = interest_month.checked_add(interest).ok_or_else(|| {
                    AppError::Validation("monthly debt interest is too large".into())
                })?;
            }
        }
        let mut available = monthly_budget;
        let mut paid_month = 0_i64;
        for state in &mut states {
            if state.1 > 0 {
                let payment = state.0.minimum.min(state.1).min(available);
                state.1 -= payment;
                available -= payment;
                paid_month = paid_month.checked_add(payment).ok_or_else(|| {
                    AppError::Validation("monthly debt payment is too large".into())
                })?;
            }
        }
        while available > 0 {
            let target = states
                .iter()
                .enumerate()
                .filter(|(_, v)| v.1 > 0)
                .min_by(|(_, a), (_, b)| {
                    if strategy == "avalanche" {
                        b.0.rate_bps.cmp(&a.0.rate_bps).then(a.1.cmp(&b.1))
                    } else {
                        a.1.cmp(&b.1).then(b.0.rate_bps.cmp(&a.0.rate_bps))
                    }
                })
                .map(|(i, _)| i);
            let Some(i) = target else {
                break;
            };
            let payment = available.min(states[i].1);
            states[i].1 -= payment;
            available -= payment;
            paid_month = paid_month
                .checked_add(payment)
                .ok_or_else(|| AppError::Validation("monthly debt payment is too large".into()))?;
        }
        total_paid = total_paid
            .checked_add(paid_month)
            .ok_or_else(|| AppError::Validation("debt payment total is too large".into()))?;
        let date = as_of
            .with_day(1)
            .unwrap()
            .checked_add_months(Months::new(step))
            .ok_or_else(|| AppError::Validation("debt projection date is out of range".into()))?;
        for state in &mut states {
            if state.1 == 0 && state.3.is_none() {
                state.3 = Some(date.format("%Y-%m").to_string());
            }
        }
        months.push(DebtMonthProjection {
            month: date.format("%Y-%m").to_string(),
            payment_cents: paid_month,
            interest_cents: interest_month,
            remaining_cents: checked_total(states.iter().map(|v| v.1), "remaining debt")?,
        });
        if paid_month <= interest_month && states.iter().any(|v| v.1 > 0) {
            warnings.push("The configured monthly payment does not exceed accruing interest; this strategy cannot amortize the debt.".into());
            break;
        }
    }
    if states.iter().any(|v| v.1 > 0) && warnings.is_empty() {
        warnings.push("Projection exceeded 100 years; increase minimum or extra payments.".into());
    }
    let items = states
        .iter()
        .map(|v| DebtItemProjection {
            key: v.0.key.clone(),
            name: v.0.name.clone(),
            source: v.0.source.clone(),
            starting_balance_cents: v.0.balance,
            annual_rate_bps: v.0.rate_bps,
            minimum_payment_cents: v.0.minimum,
            payoff_month: v.3.clone(),
            total_interest_cents: v.2,
        })
        .collect::<Vec<_>>();
    let total_interest = checked_total(
        items.iter().map(|v| v.total_interest_cents),
        "debt interest",
    )?;
    let debt_free = if states.iter().all(|v| v.1 == 0) {
        months.last().map(|v| v.month.clone())
    } else {
        None
    };
    Ok(DebtStrategyProjection {
        strategy: strategy.into(),
        debt_free_month: debt_free,
        total_interest_cents: total_interest,
        total_paid_cents: total_paid,
        items,
        monthly: months,
        warnings,
    })
}
