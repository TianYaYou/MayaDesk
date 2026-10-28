use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::str::FromStr;
use tracing::info;

use crate::auth::hash_password;
use crate::config::AppConfig;

pub async fn init_db(config: &AppConfig) -> anyhow::Result<SqlitePool> {
    let db_url = format!("sqlite://{}", config.database.sqlite_path);
    let opts = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePool::connect_with(opts).await?;

    if config.database.auto_migrate {
        let schema_sql = include_str!("../migrations/0001_initial_schema.sql");
        sqlx::raw_sql(schema_sql).execute(&pool).await?;
        info!("SQLite WAL schema verified at {}", config.database.sqlite_path);
    }

    // Seed default admin account if not exists
    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(&config.auth.default_admin_email)
        .fetch_optional(&pool)
        .await?;

    if existing.is_none() {
        let admin_id = "usr_admin_default".to_string();
        let pwd_hash = hash_password(&config.auth.default_admin_password)?;
        sqlx::query(
            "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'admin')",
        )
        .bind(&admin_id)
        .bind(&config.auth.default_admin_email)
        .bind("Admin")
        .bind(&pwd_hash)
        .execute(&pool)
        .await?;
        info!(
            "Seeded default admin user: {}",
            config.auth.default_admin_email
        );
    }

    Ok(pool)
}
