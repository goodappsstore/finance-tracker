//! Small, dependency-light client for Frankfurter. Persistence and cache policy
//! deliberately live in `db::fx`; this module only performs an HTTP request.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct FrankfurterRate {
    pub date: String,
    pub base: String,
    pub quote: String,
    pub rate: serde_json::Value,
}

pub fn fetch_rate(base: &str, quote: &str, date: &str) -> Result<FrankfurterRate, String> {
    let url = format!("https://api.frankfurter.dev/v2/rate/{base}/{quote}?date={date}");
    let response = reqwest::blocking::Client::builder()
        .user_agent("finance-tracker/1.0")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Unable to create the Frankfurter client: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("Unable to reach Frankfurter: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Frankfurter did not return a rate: {error}"))?;
    response
        .json::<FrankfurterRate>()
        .map_err(|error| format!("Frankfurter returned an invalid response: {error}"))
}

pub fn rate_as_text(value: &serde_json::Value) -> Result<String, String> {
    let raw = match value {
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(text) => text.clone(),
        _ => return Err("Frankfurter returned a non-numeric exchange rate".to_string()),
    };
    let parsed = raw
        .parse::<rust_decimal::Decimal>()
        .map_err(|_| "Frankfurter returned an invalid exchange rate".to_string())?;
    if parsed <= rust_decimal::Decimal::ZERO {
        return Err("Frankfurter returned a non-positive exchange rate".to_string());
    }
    Ok(parsed.normalize().to_string())
}
