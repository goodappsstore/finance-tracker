use crate::error::AppError;

pub fn convert_cents_at_rate(amount_cents: i64, rate: &str) -> Result<i64, AppError> {
    use rust_decimal::{prelude::ToPrimitive, Decimal, RoundingStrategy};
    let rate = rate
        .trim()
        .parse::<Decimal>()
        .map_err(|_| AppError::Validation("Exchange rate must be a positive decimal".into()))?;
    if rate <= Decimal::ZERO {
        return Err(AppError::Validation(
            "Exchange rate must be positive".into(),
        ));
    }
    Decimal::from(amount_cents)
        .checked_mul(rate)
        .and_then(|value| {
            value
                .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
                .to_i64()
        })
        .ok_or_else(|| AppError::Validation("Converted amount is too large".into()))
}

pub fn parse_amount_to_cents(input: &str) -> Result<i64, AppError> {
    let amount_cents = parse_amount_core(input, false)?;
    if amount_cents <= 0 {
        return Err(AppError::field_validation("amount", "must be positive"));
    }
    Ok(amount_cents)
}

#[allow(dead_code)]
pub fn parse_signed_amount_to_cents(input: &str) -> Result<i64, AppError> {
    let amount_cents = parse_amount_core(input, true)?;
    if amount_cents == 0 {
        return Err(AppError::field_validation("amount", "cannot be zero"));
    }
    Ok(amount_cents)
}

pub fn parse_balance_to_cents(input: &str) -> Result<i64, AppError> {
    parse_amount_core(input, true)
}

fn parse_amount_core(input: &str, allow_negative: bool) -> Result<i64, AppError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::field_validation("amount", "cannot be empty"));
    }

    let (sign, unsigned) = if let Some(value) = trimmed.strip_prefix('-') {
        if !allow_negative {
            return Err(AppError::field_validation("amount", "must be positive"));
        }
        (-1_i64, value)
    } else {
        (1_i64, trimmed.strip_prefix('+').unwrap_or(trimmed))
    };

    if unsigned.is_empty() {
        return Err(AppError::field_validation(
            "amount",
            "must contain only digits and an optional decimal point",
        ));
    }

    // Accept both '.' and ',' as decimal separators so European pastes like
    // ",50" or "12,50" work. Normalise commas to dots before splitting.
    let normalized = unsigned.replace(',', ".");
    let mut parts = normalized.split('.');
    let whole_part = parts
        .next()
        .ok_or_else(|| AppError::field_validation("amount", "cannot be empty"))?;
    let fractional_part = parts.next();

    if parts.next().is_some() {
        return Err(AppError::field_validation(
            "amount",
            "can contain at most one decimal point",
        ));
    }

    if whole_part.is_empty() {
        // Leading-dot form like ".50" or ",50" -> ",50" normalised to ".50".
        // Allow it when the fractional part is a valid 1-2 digit number.
        match fractional_part {
            Some(part)
                if (part.len() == 1 || part.len() == 2)
                    && part.chars().all(|ch| ch.is_ascii_digit()) => {}
            _ => {
                return Err(AppError::field_validation(
                    "amount",
                    "must contain only digits and an optional decimal point",
                ));
            }
        }
    } else if !whole_part.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(AppError::field_validation(
            "amount",
            "must contain only digits and an optional decimal point",
        ));
    }

    let dollars: i64 = if whole_part.is_empty() {
        0
    } else {
        whole_part.parse().map_err(|_| {
            AppError::field_validation("amount", "is too large to fit in 64-bit cents")
        })?
    };

    let cents = match fractional_part {
        None => 0,
        Some(part) if part.len() == 1 && part.chars().all(|ch| ch.is_ascii_digit()) => {
            part.parse::<i64>().map_err(|_| {
                AppError::field_validation("amount", "is too large to fit in 64-bit cents")
            })? * 10
        }
        Some(part) if part.len() == 2 && part.chars().all(|ch| ch.is_ascii_digit()) => {
            part.parse::<i64>().map_err(|_| {
                AppError::field_validation("amount", "is too large to fit in 64-bit cents")
            })?
        }
        Some(_) => {
            return Err(AppError::field_validation(
                "amount",
                "can use at most two decimal places",
            ))
        }
    };

    let absolute_cents = dollars
        .checked_mul(100)
        .and_then(|value| value.checked_add(cents))
        .ok_or_else(|| {
            AppError::field_validation("amount", "is too large to fit in 64-bit cents")
        })?;

    sign.checked_mul(absolute_cents)
        .ok_or_else(|| AppError::field_validation("amount", "is too large to fit in 64-bit cents"))
}

pub fn format_cents(amount_cents: i64) -> String {
    let sign = if amount_cents < 0 { "-" } else { "" };
    let absolute = amount_cents.abs();
    let units = absolute / 100;
    let cents = absolute % 100;
    format!("{sign}{units}.{cents:02}")
}
