use super::*;

const LATEST_RATE_TTL_SECONDS: i64 = 60 * 60;

#[derive(Clone, Debug, Serialize)]
pub struct FxSettings {
    pub reporting_currency: String,
    pub default_source: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct FxRateQuote {
    pub base_currency: String,
    pub quote_currency: String,
    pub requested_on: String,
    pub quoted_on: String,
    pub rate: String,
    pub source: String,
    pub cached: bool,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ManualFxRate {
    pub base_currency: String,
    pub quote_currency: String,
    pub effective_on: String,
    pub rate: String,
    pub updated_at: String,
}

impl Db {
    pub(super) fn account_currency(&self, id: i64) -> Result<String, AppError> {
        self.conn
            .query_row(
                "SELECT currency_code FROM accounts WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(Into::into)
    }

    pub(super) fn local_fx_quote(
        &self,
        base: &str,
        quote: &str,
        date: &str,
    ) -> Result<FxRateQuote, AppError> {
        if let Some(rate) = self.lookup_manual_fx_rate(base, quote, date)? {
            return Ok(rate);
        }
        self.conn.query_row(
            "SELECT rate, quoted_on FROM fx_rate_cache WHERE base_currency=?1 AND quote_currency=?2 AND quoted_on<=?3 ORDER BY quoted_on DESC, fetched_at DESC LIMIT 1",
            params![base, quote, date], |r| Ok(FxRateQuote {
                base_currency: base.into(), quote_currency: quote.into(), requested_on: date.into(),
                rate: r.get(0)?, quoted_on: r.get(1)?, source: "frankfurter".into(), cached: true, stale: false,
            })).optional()?.ok_or_else(|| AppError::Validation(format!("Add a dated {base}/{quote} exchange rate in Settings for {date}.")))
    }

    pub(super) fn reporting_value(
        &self,
        amount: i64,
        currency: &str,
        date: &str,
    ) -> Result<i64, AppError> {
        let target = self.currency_code()?;
        if amount == 0 || currency == target {
            return Ok(amount);
        }
        let quote = self.local_fx_quote(currency, &target, date)?;
        crate::amount::convert_cents_at_rate(amount, &quote.rate)
    }

    pub fn fx_settings(&self) -> Result<FxSettings, AppError> {
        self.conn
            .query_row(
                "SELECT currency, fx_rate_mode FROM metadata WHERE id = 1",
                [],
                |row| {
                    Ok(FxSettings {
                        reporting_currency: row.get(0)?,
                        default_source: row.get(1)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn set_reporting_currency(&self, currency: &str) -> Result<String, AppError> {
        let currency = normalize_currency_code(currency)?;
        let tx = self.conn.unchecked_transaction()?;
        if currency != self.currency_code()? {
            let populated: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM accounts) OR EXISTS(SELECT 1 FROM transactions)
                 OR EXISTS(SELECT 1 FROM budgets) OR EXISTS(SELECT 1 FROM scenario_budget_overrides)
                 OR EXISTS(SELECT 1 FROM loans) OR EXISTS(SELECT 1 FROM investment_accounts)
                 OR EXISTS(SELECT 1 FROM net_worth_items) OR EXISTS(SELECT 1 FROM safe_spend_settings)
                 OR EXISTS(SELECT 1 FROM budget_moves)", [], |r| r.get(0))?;
            if populated {
                return Err(AppError::Validation("Reporting currency cannot change after financial data has been recorded. Create a new database with the desired currency.".into()));
            }
        }
        self.conn.execute(
            "UPDATE metadata SET currency = ?1 WHERE id = 1",
            params![currency],
        )?;
        tx.commit()?;
        Ok(currency)
    }

    pub fn set_fx_default_source(&self, source: &str) -> Result<String, AppError> {
        let source = normalize_fx_source(source)?;
        self.conn.execute(
            "UPDATE metadata SET fx_rate_mode = ?1 WHERE id = 1",
            params![source],
        )?;
        Ok(source)
    }

    pub fn lookup_cached_frankfurter_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
        requested_on: &str,
    ) -> Result<Option<FxRateQuote>, AppError> {
        let base_currency = normalize_currency_code(base_currency)?;
        let quote_currency = normalize_currency_code(quote_currency)?;
        let requested_on = normalize_date_value(requested_on)?;
        if base_currency == quote_currency {
            return Ok(Some(identity_rate(
                &base_currency,
                &requested_on,
                "frankfurter",
            )));
        }
        self.conn
            .query_row(
                "SELECT quoted_on, rate, fetched_at FROM fx_rate_cache
             WHERE base_currency = ?1 AND quote_currency = ?2 AND requested_on = ?3",
                params![base_currency, quote_currency, requested_on],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map(|row| {
                row.map(|(quoted_on, rate, fetched_at)| FxRateQuote {
                    base_currency,
                    quote_currency,
                    requested_on: requested_on.clone(),
                    quoted_on,
                    rate,
                    source: "frankfurter".to_string(),
                    cached: true,
                    stale: requested_on == today_iso() && is_timestamp_stale(&fetched_at),
                })
            })
            .map_err(Into::into)
    }

    pub fn cache_frankfurter_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
        requested_on: &str,
        quoted_on: &str,
        rate: &str,
    ) -> Result<FxRateQuote, AppError> {
        let base_currency = normalize_currency_code(base_currency)?;
        let quote_currency = normalize_currency_code(quote_currency)?;
        let requested_on = normalize_date_value(requested_on)?;
        let quoted_on = normalize_date_value(quoted_on)?;
        let rate = normalize_fx_rate(rate)?;
        let fetched_at = now_timestamp();
        self.conn.execute(
            "INSERT INTO fx_rate_cache (base_currency, quote_currency, requested_on, quoted_on, rate, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(base_currency, quote_currency, requested_on) DO UPDATE SET
                 quoted_on = excluded.quoted_on, rate = excluded.rate, fetched_at = excluded.fetched_at",
            params![base_currency, quote_currency, requested_on, quoted_on, rate, fetched_at],
        )?;
        Ok(FxRateQuote {
            base_currency,
            quote_currency,
            requested_on,
            quoted_on,
            rate,
            source: "frankfurter".to_string(),
            cached: false,
            stale: false,
        })
    }

    pub fn lookup_manual_fx_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
        requested_on: &str,
    ) -> Result<Option<FxRateQuote>, AppError> {
        let base_currency = normalize_currency_code(base_currency)?;
        let quote_currency = normalize_currency_code(quote_currency)?;
        let requested_on = normalize_date_value(requested_on)?;
        if base_currency == quote_currency {
            return Ok(Some(identity_rate(&base_currency, &requested_on, "manual")));
        }
        self.conn
            .query_row(
                "SELECT effective_on, rate FROM manual_fx_rates
             WHERE base_currency = ?1 AND quote_currency = ?2 AND effective_on <= ?3
             ORDER BY effective_on DESC LIMIT 1",
                params![base_currency, quote_currency, requested_on],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map(|row| {
                row.map(|(quoted_on, rate)| FxRateQuote {
                    base_currency,
                    quote_currency,
                    requested_on,
                    quoted_on,
                    rate,
                    source: "manual".to_string(),
                    cached: true,
                    stale: false,
                })
            })
            .map_err(Into::into)
    }

    pub fn save_manual_fx_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
        effective_on: &str,
        rate: &str,
    ) -> Result<ManualFxRate, AppError> {
        let base_currency = normalize_currency_code(base_currency)?;
        let quote_currency = normalize_currency_code(quote_currency)?;
        if base_currency == quote_currency {
            return Err(AppError::Validation(
                "a manual rate needs two different currencies".to_string(),
            ));
        }
        let effective_on = normalize_date_value(effective_on)?;
        let rate = normalize_fx_rate(rate)?;
        let timestamp = now_timestamp();
        self.conn.execute(
            "INSERT INTO manual_fx_rates (base_currency, quote_currency, effective_on, rate, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(base_currency, quote_currency, effective_on) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at",
            params![base_currency, quote_currency, effective_on, rate, timestamp],
        )?;
        Ok(ManualFxRate {
            base_currency,
            quote_currency,
            effective_on,
            rate,
            updated_at: timestamp,
        })
    }

    pub fn list_manual_fx_rates(&self) -> Result<Vec<ManualFxRate>, AppError> {
        let mut statement = self.conn.prepare(
            "SELECT base_currency, quote_currency, effective_on, rate, updated_at
             FROM manual_fx_rates ORDER BY effective_on DESC, base_currency, quote_currency",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ManualFxRate {
                base_currency: row.get(0)?,
                quote_currency: row.get(1)?,
                effective_on: row.get(2)?,
                rate: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_manual_fx_rate(
        &self,
        base_currency: &str,
        quote_currency: &str,
        effective_on: &str,
    ) -> Result<(), AppError> {
        let base_currency = normalize_currency_code(base_currency)?;
        let quote_currency = normalize_currency_code(quote_currency)?;
        let effective_on = normalize_date_value(effective_on)?;
        self.conn.execute("DELETE FROM manual_fx_rates WHERE base_currency = ?1 AND quote_currency = ?2 AND effective_on = ?3", params![base_currency, quote_currency, effective_on])?;
        Ok(())
    }
}

fn normalize_fx_source(source: &str) -> Result<String, AppError> {
    match source.trim().to_ascii_lowercase().as_str() {
        "frankfurter" => Ok("frankfurter".to_string()),
        "manual" => Ok("manual".to_string()),
        _ => Err(AppError::Validation(
            "rate source must be Frankfurter or manual".to_string(),
        )),
    }
}

fn normalize_fx_rate(rate: &str) -> Result<String, AppError> {
    let value = rate.trim().parse::<rust_decimal::Decimal>().map_err(|_| {
        AppError::Validation("exchange rate must be a positive decimal number".to_string())
    })?;
    if value <= rust_decimal::Decimal::ZERO {
        return Err(AppError::Validation(
            "exchange rate must be positive".to_string(),
        ));
    }
    Ok(value.normalize().to_string())
}

fn identity_rate(currency: &str, date: &str, source: &str) -> FxRateQuote {
    FxRateQuote {
        base_currency: currency.to_string(),
        quote_currency: currency.to_string(),
        requested_on: date.to_string(),
        quoted_on: date.to_string(),
        rate: "1".to_string(),
        source: source.to_string(),
        cached: true,
        stale: false,
    }
}

fn today_iso() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn is_timestamp_stale(raw: &str) -> bool {
    chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .map(|timestamp| {
            Local::now().naive_local() - timestamp
                > chrono::Duration::seconds(LATEST_RATE_TTL_SECONDS)
        })
        .unwrap_or(true)
}
