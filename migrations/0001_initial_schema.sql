-- Support Triage Web App Database Schema
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  google_id TEXT UNIQUE NOT NULL,
  company_name TEXT,
  stripe_customer_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE usage_monthly (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  classifications_used INTEGER DEFAULT 0,
  quota_limit INTEGER DEFAULT 500,
  overage_charges REAL DEFAULT 0,
  last_updated INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, month)
);

CREATE TABLE classifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ticket_content TEXT NOT NULL,
  classification_result TEXT NOT NULL,
  ai_provider TEXT NOT NULL,
  processing_time_ms INTEGER,
  confidence_score REAL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_usage_monthly_user_month ON usage_monthly(user_id, month);
CREATE INDEX idx_classifications_user_created ON classifications(user_id, created_at);
