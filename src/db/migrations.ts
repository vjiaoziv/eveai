import type { Db } from './sqlite.js';
import { SCHEMA_SQL } from './schema.js';
import { pathToFileURL } from 'node:url';

function backfillPaperTradingEscrow(db: Db): void {
  // Historical rows can be reconstructed only when their escrow_lock journal
  // entry exists. Rows without that evidence are isolated instead of being
  // allowed to create unexplained account liabilities.
  db.prepare(`
    UPDATE paper_trading_orders
    SET escrow_locked = max(0,
      COALESCE((SELECT amount FROM paper_trading_journal j WHERE j.order_id = paper_trading_orders.order_id AND j.entry_type = 'escrow_lock'), 0)
      - COALESCE((SELECT SUM(amount) FROM paper_trading_journal j WHERE j.order_id = paper_trading_orders.order_id AND j.entry_type IN ('order_spend', 'fee_payment', 'escrow_release')), 0)
    )
    WHERE escrow_migration_status = 'legacy_pending'
      AND order_type = 'buy'
      AND EXISTS (SELECT 1 FROM paper_trading_journal j WHERE j.order_id = paper_trading_orders.order_id AND j.entry_type = 'escrow_lock')
  `).run();
  db.prepare(`
    UPDATE paper_trading_orders
    SET fee_reserved = max(0, escrow_locked - max(0, quantity - filled_quantity) * price)
    WHERE escrow_migration_status = 'legacy_pending'
      AND order_type = 'buy'
      AND EXISTS (SELECT 1 FROM paper_trading_journal j WHERE j.order_id = paper_trading_orders.order_id AND j.entry_type = 'escrow_lock')
  `).run();
  db.prepare(`
    UPDATE paper_trading_orders
    SET escrow_migration_status = 'recovered'
    WHERE escrow_migration_status = 'legacy_pending'
      AND order_type = 'buy'
      AND EXISTS (SELECT 1 FROM paper_trading_journal j WHERE j.order_id = paper_trading_orders.order_id AND j.entry_type = 'escrow_lock')
  `).run();
  db.prepare(`
    UPDATE paper_trading_orders
    SET escrow_locked = 0, fee_reserved = 0, escrow_migration_status = 'unrecoverable'
    WHERE escrow_migration_status = 'legacy_pending'
  `).run();
}

export function runMigrations(db: Db): void {
  const migrate = db.transaction(() => {
    ensureSchema(db);
    addColumnIfMissing(db, 'telegram_sessions', 'active_character_id', 'INTEGER');
    addColumnIfMissing(db, 'users', 'active_character_version', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'agent_threads', 'character_id', 'INTEGER');
    addColumnIfMissing(db, 'esi_cache', 'etag', 'TEXT');
    addColumnIfMissing(db, 'esi_cache', 'last_modified', 'TEXT');
    addColumnIfMissing(db, 'agent_threads', 'last_response_id', 'TEXT');
    addColumnIfMissing(db, 'agent_threads', 'last_response_message_id', 'INTEGER');
    createIndexIfMissing(db, 'idx_agent_threads_chat_character', 'agent_threads', 'chat_id, character_id');
    // Orphaned web-lane adoption scans telegram_sessions by username='web'.
    createIndexIfMissing(db, 'idx_telegram_sessions_username', 'telegram_sessions', 'username');
    backfillThreadCharacters(db);

    addColumnIfMissing(db, 'eve_accounts', 'user_id', 'INTEGER');
    addColumnIfMissing(db, 'eve_accounts', 'consent_version', 'TEXT');
    addColumnIfMissing(db, 'eve_accounts', 'consent_language', 'TEXT');
    addColumnIfMissing(db, 'eve_accounts', 'consented_at', 'TEXT');
    addColumnIfMissing(db, 'eve_accounts', 'owner_hash', 'TEXT');
    addColumnIfMissing(
      db, 'sde_types', 'market_group_id',
      "INTEGER GENERATED ALWAYS AS (json_extract(data_json, '$.marketGroupID')) VIRTUAL",
    );
    addColumnIfMissing(
      db, 'sde_types', 'published',
      "INTEGER GENERATED ALWAYS AS (json_extract(data_json, '$.published')) VIRTUAL",
    );
    createIndexIfMissing(db, 'idx_sde_types_market_group', 'sde_types', 'published, market_group_id, name COLLATE NOCASE');
    addColumnIfMissing(db, 'eve_character_links', 'user_id', 'INTEGER');
    addColumnIfMissing(db, 'agent_threads', 'user_id', 'INTEGER');
    createIndexIfMissing(db, 'idx_agent_threads_user', 'agent_threads', 'user_id');
    createIndexIfMissing(db, 'idx_eve_character_links_user', 'eve_character_links', 'user_id');
    backfillUsers(db);
    clearLegacyOauthStates(db);
    addColumnIfMissing(db, 'agent_threads', 'total_tokens', 'INTEGER DEFAULT 0');
    addColumnIfMissing(db, 'messages', 'web_request_id', 'TEXT');
    createIndexIfMissing(db, 'idx_messages_thread', 'messages', 'thread_id');
    createIndexIfMissing(db, 'idx_messages_web_request', 'messages', 'web_request_id');
    ensureHeartbeatConfig(db);
    addColumnIfMissing(db, 'heartbeat_config', 'state_json', "TEXT NOT NULL DEFAULT '{}'");
    ensureKillWatches(db);
    // Feed matching looks watches up by exact topic for every killmail.
    createIndexIfMissing(db, 'idx_kill_watches_topic', 'kill_watches', 'topic');
    ensureEveKillFeedState(db);
    removeLegacyRouteWatchesOnce(db);
    ensureRouteMonitors(db);
    ensureRouteMonitorKillDedup(db);
    cutoverMarkedLegacyCliIdentity(db);
    ensureIntelNotes(db);
    ensureWebSessions(db);
    ensureWebAgentRequests(db);
    addColumnIfMissing(db, 'auth_requests', 'requested_scopes_json', 'TEXT');
    addColumnIfMissing(db, 'auth_requests', 'consent_version', 'TEXT');
    addColumnIfMissing(db, 'auth_requests', 'consent_language', 'TEXT');
    addColumnIfMissing(db, 'auth_requests', 'consented_at', 'TEXT');
    ensureConsentLanguageGuards(db);
    ensureProcessedUpdates(db);
    // Market index cleanup: the history (type_id, date) index covered no
    // query (every read goes through the (region_id, type_id, date) PK), and
    // the alerts claim runs by PK while point lookups filter (user_id, status).
    db.exec('DROP INDEX IF EXISTS idx_market_price_history_type_date');
    db.exec('DROP INDEX IF EXISTS idx_market_alerts_active');
    createIndexIfMissing(db, 'idx_market_price_alerts_user_status', 'market_price_alerts', 'user_id, status');
    // History worker prune clock: pairs no seed wants any more age out.
    addColumnIfMissing(db, 'market_history_sync', 'last_wanted_at', 'TEXT');
    addColumnIfMissing(db, 'paper_trading_orders', 'escrow_locked', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'paper_trading_orders', 'fee_reserved', 'REAL NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'paper_trading_orders', 'escrow_migration_status', "TEXT NOT NULL DEFAULT 'legacy_pending'");
    addColumnIfMissing(db, 'paper_trading_orders', 'snapshot_id', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_fills (
        fill_id           TEXT PRIMARY KEY,
        order_id          TEXT NOT NULL,
        opportunity_id    TEXT,
        snapshot_id       TEXT,
        filled_at         TEXT NOT NULL,
        price             REAL NOT NULL,
        quantity          INTEGER NOT NULL,
        fees              REAL NOT NULL DEFAULT 0,
        remaining_quantity INTEGER NOT NULL,
        basis             TEXT NOT NULL,
        model_version     TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_paper_fills_order ON paper_fills(order_id, filled_at);
    `);
    // P8.7: preserve both sides of an opportunity and its four profit layers.
    addColumnIfMissing(db, 'trade_opportunities_log', 'buy_location_id', 'INTEGER');
    addColumnIfMissing(db, 'trade_opportunities_log', 'sell_location_id', 'INTEGER');
    addColumnIfMissing(db, 'trade_opportunities_log', 'buy_region_id', 'INTEGER');
    addColumnIfMissing(db, 'trade_opportunities_log', 'sell_region_id', 'INTEGER');
    addColumnIfMissing(db, 'trade_opportunities_log', 'buy_snapshot_id', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'sell_snapshot_id', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'buy_snapshot_timestamp', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'sell_snapshot_timestamp', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'fee_model_version', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'executable_quantity', 'INTEGER');
    addColumnIfMissing(db, 'trade_opportunities_log', 'theoretical_gross_profit', 'REAL');
    addColumnIfMissing(db, 'trade_opportunities_log', 'executable_gross_profit', 'REAL');
    addColumnIfMissing(db, 'trade_opportunities_log', 'fee_net_profit', 'REAL');
    addColumnIfMissing(db, 'trade_opportunities_log', 'comprehensive_net_profit', 'REAL');
    addColumnIfMissing(db, 'trade_opportunities_log', 'comprehensive_net_profit_status', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
    addColumnIfMissing(db, 'trade_opportunities_log', 'profit_layers_json', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'capital_required', 'REAL');
    addColumnIfMissing(db, 'trade_opportunities_log', 'logistics_cost', 'REAL');
    addColumnIfMissing(db, 'trade_opportunities_log', 'opportunity_expires_at', 'TEXT');
    addColumnIfMissing(db, 'trade_opportunities_log', 'opportunity_status', "TEXT NOT NULL DEFAULT 'pending'");
    addColumnIfMissing(db, 'paper_trading_orders', 'submitted_at', 'TEXT');
    addColumnIfMissing(db, 'paper_trading_orders', 'fill_mode', "TEXT NOT NULL DEFAULT 'immediate'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
        snapshot_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id        TEXT NOT NULL,
        available_cash    REAL NOT NULL,
        escrow_locked     REAL NOT NULL,
        inventory_cost    REAL NOT NULL,
        inventory_value   REAL NOT NULL,
        total_equity      REAL NOT NULL,
        source_event      TEXT NOT NULL,
        source_id         TEXT,
        snapshot_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_paper_equity_account_time
        ON paper_equity_snapshots(account_id, snapshot_at, snapshot_id);
      CREATE TABLE IF NOT EXISTS paper_position_exits (
        exit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id     TEXT NOT NULL,
        paper_id     TEXT NOT NULL,
        character_id INTEGER NOT NULL,
        type_id      INTEGER NOT NULL,
        quantity     INTEGER NOT NULL,
        cost_price   REAL NOT NULL,
        exit_price   REAL NOT NULL,
        gross_pnl    REAL NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_paper_position_exits_order
        ON paper_position_exits(order_id, created_at, exit_id);
      CREATE TABLE IF NOT EXISTS paper_order_state_events (
        event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id      TEXT NOT NULL,
        from_status   TEXT,
        to_status     TEXT NOT NULL,
        reason        TEXT,
        metadata_json TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_paper_order_state_events_order
        ON paper_order_state_events(order_id, created_at, event_id);
    `);

    // P9: real-market research and manually executed trading remain separate
    // from every PAPER_* table above.
    db.exec(`
      CREATE TABLE IF NOT EXISTS p9_scan_settings (
        character_id              INTEGER PRIMARY KEY,
        hubs_json                 TEXT NOT NULL,
        strategies_json           TEXT NOT NULL,
        min_net_profit            REAL NOT NULL DEFAULT 100000,
        min_roi_pct               REAL NOT NULL DEFAULT 5,
        max_capital               REAL NOT NULL DEFAULT 100000000,
        max_market_age_minutes    INTEGER NOT NULL DEFAULT 60,
        max_results               INTEGER NOT NULL DEFAULT 100,
        auto_scan_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (auto_scan_enabled IN (0, 1)),
        auto_scan_interval_minutes INTEGER NOT NULL DEFAULT 30,
        updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS p9_real_opportunities (
        opportunity_id           TEXT PRIMARY KEY,
        character_id             INTEGER NOT NULL,
        scan_key                 TEXT NOT NULL,
        strategy                 TEXT NOT NULL,
        type_id                  INTEGER NOT NULL,
        type_name_en             TEXT,
        type_name_zh             TEXT,
        buy_location_id          INTEGER NOT NULL,
        buy_location_name        TEXT,
        sell_location_id         INTEGER NOT NULL,
        sell_location_name       TEXT,
        buy_region_id            INTEGER NOT NULL,
        sell_region_id           INTEGER NOT NULL,
        buy_price                REAL NOT NULL,
        sell_price               REAL NOT NULL,
        suggested_quantity       INTEGER NOT NULL,
        executable_quantity      INTEGER NOT NULL,
        purchase_amount          REAL NOT NULL,
        sales_revenue            REAL NOT NULL,
        broker_fees              REAL NOT NULL,
        sales_tax                REAL NOT NULL,
        other_fees               REAL NOT NULL DEFAULT 0,
        theoretical_gross_profit REAL NOT NULL,
        executable_gross_profit  REAL NOT NULL,
        fee_net_profit           REAL NOT NULL,
        comprehensive_net_profit REAL,
        comprehensive_status     TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (comprehensive_status IN ('CALCULATED', 'UNKNOWN')),
        capital_required         REAL NOT NULL,
        roi_pct                  REAL NOT NULL,
        logistics_cost           REAL,
        liquidity                TEXT NOT NULL DEFAULT 'UNKNOWN',
        risk_level               TEXT NOT NULL DEFAULT 'MEDIUM',
        risk_flags_json          TEXT NOT NULL DEFAULT '[]',
        buy_snapshot_id          TEXT NOT NULL,
        sell_snapshot_id         TEXT NOT NULL,
        buy_snapshot_at          TEXT,
        sell_snapshot_at         TEXT,
        buy_snapshot_age_minutes REAL,
        sell_snapshot_age_minutes REAL,
        data_source              TEXT NOT NULL DEFAULT 'esi_market_orders',
        data_complete            INTEGER NOT NULL DEFAULT 1 CHECK (data_complete IN (0, 1)),
        data_fresh               INTEGER NOT NULL DEFAULT 0 CHECK (data_fresh IN (0, 1)),
        spread_detected          INTEGER NOT NULL DEFAULT 0 CHECK (spread_detected IN (0, 1)),
        market_executable        INTEGER NOT NULL DEFAULT 0 CHECK (market_executable IN (0, 1)),
        profit_after_known_fees  INTEGER NOT NULL DEFAULT 0 CHECK (profit_after_known_fees IN (0, 1)),
        logistics_known          INTEGER NOT NULL DEFAULT 0 CHECK (logistics_known IN (0, 1)),
        overall_profit_known     INTEGER NOT NULL DEFAULT 0 CHECK (overall_profit_known IN (0, 1)),
        trade_plan_complete      INTEGER NOT NULL DEFAULT 0 CHECK (trade_plan_complete IN (0, 1)),
        calculation_version      TEXT NOT NULL,
        original_snapshot_json   TEXT NOT NULL,
        state                    TEXT NOT NULL DEFAULT 'NEW'
          CHECK (state IN ('NEW', 'WATCHING', 'ACTIONABLE', 'STALE', 'EXPIRED', 'REJECTED', 'ARCHIVED')),
        detected_at              TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at               TEXT NOT NULL,
        UNIQUE (character_id, scan_key)
      );
      CREATE INDEX IF NOT EXISTS idx_p9_opportunities_char_state
        ON p9_real_opportunities(character_id, state, updated_at);

      CREATE TABLE IF NOT EXISTS p9_trade_plans (
        plan_id             TEXT PRIMARY KEY,
        character_id        INTEGER NOT NULL,
        opportunity_id      TEXT NOT NULL,
        strategy            TEXT NOT NULL,
        type_id             INTEGER NOT NULL,
        buy_location_id     INTEGER NOT NULL,
        sell_location_id    INTEGER NOT NULL,
        quantity            INTEGER NOT NULL,
        buy_price           REAL NOT NULL,
        sell_price          REAL NOT NULL,
        estimated_buy_cost  REAL NOT NULL,
        estimated_sell_revenue REAL NOT NULL,
        estimated_fees      REAL NOT NULL,
        estimated_fee_net_profit REAL NOT NULL,
        estimated_comprehensive_profit REAL,
        comprehensive_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        capital_required    REAL NOT NULL,
        risk_flags_json     TEXT NOT NULL DEFAULT '[]',
        valid_until         TEXT NOT NULL,
        exit_plan           TEXT,
        notes               TEXT,
        status              TEXT NOT NULL DEFAULT 'PLANNED'
          CHECK (status IN ('PLANNED', 'USER_CONFIRMED', 'PARTIALLY_EXECUTED', 'EXECUTED', 'HOLDING', 'PARTIALLY_EXITED', 'CLOSED', 'CANCELLED')),
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_p9_plans_char_status
        ON p9_trade_plans(character_id, status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_p9_plans_opportunity
        ON p9_trade_plans(opportunity_id);

      CREATE TABLE IF NOT EXISTS p9_real_trades (
        trade_id        TEXT PRIMARY KEY,
        character_id    INTEGER NOT NULL,
        client_key      TEXT NOT NULL,
        external_id     TEXT,
        opportunity_id  TEXT,
        plan_id         TEXT,
        direction       TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
        type_id         INTEGER NOT NULL,
        location_id     INTEGER NOT NULL,
        quantity        INTEGER NOT NULL CHECK (quantity > 0),
        price           REAL NOT NULL CHECK (price >= 0),
        fee             REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
        fee_status      TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (fee_status IN ('CONFIRMED', 'UNKNOWN')),
        trade_time      TEXT NOT NULL,
        source          TEXT NOT NULL CHECK (source IN ('manual', 'esi')),
        confirmed       INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0, 1)),
        realized_pnl    REAL,
        pnl_status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (pnl_status IN ('PENDING', 'CALCULATED', 'UNKNOWN_COST')),
        notes           TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (character_id, client_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_p9_trades_external
        ON p9_real_trades(character_id, external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_p9_trades_char_time
        ON p9_real_trades(character_id, trade_time, trade_id);

      CREATE TABLE IF NOT EXISTS p9_inventory_lots (
        lot_id            TEXT PRIMARY KEY,
        character_id      INTEGER NOT NULL,
        item_id           INTEGER,
        type_id           INTEGER NOT NULL,
        location_id       INTEGER NOT NULL,
        quantity          INTEGER NOT NULL CHECK (quantity >= 0),
        original_quantity INTEGER NOT NULL CHECK (original_quantity >= 0),
        cost_per_unit     REAL,
        cost_status       TEXT NOT NULL CHECK (cost_status IN ('CONFIRMED', 'UNKNOWN')),
        source            TEXT NOT NULL CHECK (source IN ('manual', 'trade')),
        acquired_at       TEXT NOT NULL,
        trade_id          TEXT,
        opportunity_id    TEXT,
        notes             TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_p9_lots_char_type
        ON p9_inventory_lots(character_id, type_id, acquired_at, lot_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_p9_lots_item
        ON p9_inventory_lots(character_id, item_id) WHERE item_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS p9_inventory_moves (
        move_id          INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id     INTEGER NOT NULL,
        trade_id         TEXT NOT NULL,
        lot_id           TEXT NOT NULL,
        type_id          INTEGER NOT NULL,
        quantity         INTEGER NOT NULL,
        cost_per_unit    REAL,
        exit_price       REAL NOT NULL,
        allocated_fee    REAL NOT NULL,
        realized_pnl     REAL,
        pnl_status       TEXT NOT NULL CHECK (pnl_status IN ('CALCULATED', 'UNKNOWN_COST')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_p9_moves_trade
        ON p9_inventory_moves(trade_id);
      CREATE INDEX IF NOT EXISTS idx_p9_moves_char_type
        ON p9_inventory_moves(character_id, type_id);

      CREATE TABLE IF NOT EXISTS p9_trade_audit_events (
        event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id  INTEGER NOT NULL,
        trade_id      TEXT,
        lot_id        TEXT,
        plan_id       TEXT,
        action        TEXT NOT NULL,
        before_json   TEXT,
        after_json    TEXT,
        actor         TEXT NOT NULL DEFAULT 'user',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_p9_audit_char_time
        ON p9_trade_audit_events(character_id, created_at, event_id);

      CREATE TABLE IF NOT EXISTS p9_esi_transaction_sync (
        character_id        INTEGER PRIMARY KEY,
        last_transaction_id INTEGER,
        last_synced_at      TEXT,
        status              TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
        error               TEXT
      );

      CREATE TABLE IF NOT EXISTS p9_job_runs (
        job_id        TEXT PRIMARY KEY,
        job_type      TEXT NOT NULL,
        character_id  INTEGER,
        status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at   TEXT,
        summary_json  TEXT,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_p9_jobs_type_time
        ON p9_job_runs(job_type, started_at);
    `);
    // P9.1.1: independent opportunity attributes. Existing P9.1 tables get the
    // columns here; ACTIONABLE now requires trade_plan_complete, so a price
    // spread with unknown logistics stays WATCHING instead of actionable.
    addColumnIfMissing(db, 'p9_real_opportunities', 'spread_detected', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'p9_real_opportunities', 'market_executable', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'p9_real_opportunities', 'profit_after_known_fees', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'p9_real_opportunities', 'logistics_known', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'p9_real_opportunities', 'overall_profit_known', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'p9_real_opportunities', 'trade_plan_complete', 'INTEGER NOT NULL DEFAULT 0');

    // P9.2 real assets: character_assets stays the mutable current set; these
    // tables add job history, immutable snapshots, resolution cache, change
    // history, local tags, valuations and opportunity matches. All CREATE IF
    // NOT EXISTS so the migration is safely re-runnable on production data.
    db.exec(`
      CREATE TABLE IF NOT EXISTS real_asset_sync_jobs (
        job_id          TEXT PRIMARY KEY,
        character_id    INTEGER NOT NULL,
        trigger         TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'auto', 'api')),
        status          TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        phase           TEXT NOT NULL DEFAULT 'fetch' CHECK (phase IN ('fetch', 'validate', 'commit', 'done')),
        pages_total     INTEGER,
        pages_fetched   INTEGER,
        items_fetched   INTEGER,
        items_committed INTEGER,
        items_skipped   INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        duration_ms     INTEGER,
        snapshot_id     TEXT,
        last_error      TEXT,
        source          TEXT NOT NULL DEFAULT 'esi_character_assets'
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_jobs_char_started
        ON real_asset_sync_jobs(character_id, started_at);

      CREATE TABLE IF NOT EXISTS real_asset_snapshots (
        snapshot_id         TEXT PRIMARY KEY,
        character_id        INTEGER NOT NULL,
        job_id              TEXT,
        started_at          TEXT NOT NULL,
        completed_at        TEXT,
        status              TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SUPERSEDED')),
        total_items         INTEGER NOT NULL DEFAULT 0,
        total_unique_types  INTEGER NOT NULL DEFAULT 0,
        total_locations     INTEGER NOT NULL DEFAULT 0,
        total_quantity      INTEGER NOT NULL DEFAULT 0,
        data_hash           TEXT NOT NULL,
        source              TEXT NOT NULL DEFAULT 'esi_character_assets',
        error_summary       TEXT,
        is_latest           INTEGER NOT NULL DEFAULT 0 CHECK (is_latest IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_snapshots_char_completed
        ON real_asset_snapshots(character_id, completed_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_real_asset_snapshots_latest
        ON real_asset_snapshots(character_id) WHERE is_latest = 1;

      CREATE TABLE IF NOT EXISTS real_asset_snapshot_items (
        snapshot_id       TEXT NOT NULL,
        item_id           INTEGER NOT NULL,
        type_id           INTEGER NOT NULL,
        quantity          INTEGER NOT NULL DEFAULT 1,
        location_id       INTEGER NOT NULL,
        location_type     TEXT,
        location_flag     TEXT,
        is_singleton      INTEGER NOT NULL DEFAULT 0,
        is_blueprint_copy INTEGER,
        parent_item_id    INTEGER,
        raw_json          TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_snap_items_type
        ON real_asset_snapshot_items(snapshot_id, type_id);
      CREATE INDEX IF NOT EXISTS idx_real_asset_snap_items_location
        ON real_asset_snapshot_items(snapshot_id, location_id);

      CREATE TABLE IF NOT EXISTS real_asset_locations (
        location_id        INTEGER PRIMARY KEY,
        location_type      TEXT NOT NULL,
        location_name      TEXT,
        solar_system_id    INTEGER,
        solar_system_name  TEXT,
        region_id          INTEGER,
        region_name        TEXT,
        parent_location_id INTEGER,
        resolution_status  TEXT NOT NULL CHECK (resolution_status IN ('RESOLVED', 'PARTIALLY_RESOLVED', 'UNKNOWN', 'ACCESS_RESTRICTED')),
        resolution_source  TEXT NOT NULL,
        raw_json           TEXT,
        resolved_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS real_asset_changes (
        change_id          TEXT PRIMARY KEY,
        character_id       INTEGER NOT NULL,
        item_id            INTEGER NOT NULL,
        type_id            INTEGER NOT NULL,
        change_type        TEXT NOT NULL CHECK (change_type IN ('ADDED', 'QTY_INCREASED', 'QTY_DECREASED', 'MOVED', 'REMOVED', 'REAPPEARED', 'CONTAINER_CHANGED')),
        prev_quantity      INTEGER,
        new_quantity       INTEGER,
        prev_location_id   INTEGER,
        new_location_id    INTEGER,
        source_class       TEXT NOT NULL DEFAULT 'OBSERVED_CHANGE' CHECK (source_class IN ('OBSERVED_CHANGE', 'EVIDENCE_CORRELATED', 'SOURCE_CONFIRMED', 'SOURCE_UNKNOWN')),
        confidence         TEXT NOT NULL DEFAULT 'HIGH' CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
        from_snapshot_id   TEXT,
        to_snapshot_id     TEXT NOT NULL,
        detected_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_changes_char_detected
        ON real_asset_changes(character_id, detected_at);
      CREATE INDEX IF NOT EXISTS idx_real_asset_changes_item
        ON real_asset_changes(character_id, item_id, detected_at);

      CREATE TABLE IF NOT EXISTS real_asset_tags (
        character_id INTEGER NOT NULL,
        item_id      INTEGER NOT NULL,
        tag          TEXT NOT NULL CHECK (tag IN ('SELF_USE', 'FOR_SALE', 'PRODUCTION', 'MISSION', 'SPARE', 'TRADE_STOCK', 'HOLD')),
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (character_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS real_asset_valuations (
        valuation_id       TEXT PRIMARY KEY,
        character_id       INTEGER NOT NULL,
        snapshot_id        TEXT NOT NULL,
        hub_location_id    INTEGER NOT NULL,
        hub_region_id      INTEGER NOT NULL,
        market_snapshot_at TEXT,
        fee_model_version  TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        created_at         TEXT NOT NULL,
        completed_at       TEXT,
        items_valued       INTEGER NOT NULL DEFAULT 0,
        items_unknown      INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_valuations_char_created
        ON real_asset_valuations(character_id, created_at);

      CREATE TABLE IF NOT EXISTS real_asset_valuation_items (
        valuation_id             TEXT NOT NULL,
        item_id                  INTEGER NOT NULL,
        type_id                  INTEGER NOT NULL,
        quantity                 INTEGER NOT NULL,
        market_reference_value   REAL,
        bid_liquidation_gross    REAL,
        bid_liquidation_net      REAL,
        fillable_quantity        INTEGER,
        unfillable_quantity      INTEGER,
        ask_replacement_gross    REAL,
        ask_replacement_net      REAL,
        statuses_json            TEXT NOT NULL DEFAULT '[]',
        flags_json               TEXT NOT NULL DEFAULT '[]',
        price_source             TEXT,
        PRIMARY KEY (valuation_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_val_items_type
        ON real_asset_valuation_items(valuation_id, type_id);

      CREATE TABLE IF NOT EXISTS real_asset_opportunity_matches (
        match_id          TEXT PRIMARY KEY,
        character_id      INTEGER NOT NULL,
        opportunity_id    TEXT NOT NULL,
        type_id           INTEGER NOT NULL,
        held_quantity     INTEGER NOT NULL DEFAULT 0,
        accessible_quantity INTEGER NOT NULL DEFAULT 0,
        required_quantity INTEGER NOT NULL DEFAULT 0,
        support_class     TEXT NOT NULL CHECK (support_class IN ('SUPPORTED', 'PARTIAL', 'NEEDS_PURCHASE', 'UNAVAILABLE', 'UNKNOWN')),
        needs_transport   INTEGER NOT NULL DEFAULT 0 CHECK (needs_transport IN (0, 1)),
        locations_json    TEXT NOT NULL DEFAULT '[]',
        snapshot_id       TEXT,
        computed_at       TEXT NOT NULL,
        UNIQUE (character_id, opportunity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_real_asset_matches_char
        ON real_asset_opportunity_matches(character_id, computed_at);
    `);


    // P9.3: append-only REAL accounting ledger. These tables are deliberately
    // separate from every PAPER_* table and from P9.2's observed asset history.
    db.exec(`
      CREATE TABLE IF NOT EXISTS real_trade_records (
        record_id             TEXT PRIMARY KEY,
        character_id          INTEGER NOT NULL,
        ledger_key            TEXT NOT NULL,
        record_state          TEXT NOT NULL DEFAULT 'DRAFT'
          CHECK (record_state IN ('DRAFT', 'ACTIVE', 'VERIFIED', 'REJECTED', 'REVERSED', 'CORRECTED')),
        verification_status   TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (verification_status IN ('VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED')),
        trade_kind            TEXT NOT NULL
          CHECK (trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL', 'FEE_ADJUSTMENT', 'COST_ADJUSTMENT', 'INVENTORY_TRANSFER', 'REVERSAL')),
        direction             TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'NONE')),
        type_id               INTEGER NOT NULL,
        location_id           INTEGER NOT NULL,
        quantity              INTEGER NOT NULL CHECK (quantity >= 0),
        unit_price            REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
        gross_amount          REAL GENERATED ALWAYS AS (quantity * unit_price) STORED,
        fee_status            TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (fee_status IN ('COMPLETE', 'UNKNOWN')),
        trade_time            TEXT NOT NULL,
        source_type           TEXT NOT NULL,
        source_ref            TEXT,
        source_hash           TEXT,
        order_id              TEXT,
        fill_id               TEXT,
        execution_status      TEXT NOT NULL DEFAULT 'MANUAL_ENTRY'
          CHECK (execution_status IN ('FULL_FILL', 'PARTIAL_FILL', 'MULTI_BATCH', 'MANUAL_ENTRY', 'ADJUSTMENT', 'TRANSFER')),
        opportunity_id        TEXT,
        plan_id               TEXT,
        notes                 TEXT,
        adjustment_mode       TEXT CHECK (adjustment_mode IN ('INCREASE', 'DECREASE')),
        adjustment_amount     REAL,
        target_lot_id         TEXT,
        from_location_id      INTEGER,
        to_location_id        INTEGER,
        supersedes_record_id  TEXT,
        reverses_record_id    TEXT,
        rejected_reason       TEXT,
        verified_at           TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
        is_paper              INTEGER NOT NULL DEFAULT 0 CHECK (is_paper = 0),
        UNIQUE (character_id, ledger_key)
      );
      CREATE INDEX IF NOT EXISTS idx_real_trade_records_char_time
        ON real_trade_records(character_id, trade_time, record_id);
      CREATE INDEX IF NOT EXISTS idx_real_trade_records_source
        ON real_trade_records(character_id, source_type, source_ref);

      CREATE TABLE IF NOT EXISTS real_trade_events (
        event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id   INTEGER NOT NULL,
        record_id      TEXT NOT NULL,
        event_type     TEXT NOT NULL,
        actor_type     TEXT NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'ESI_SYNC')),
        actor_id       TEXT,
        before_json    TEXT,
        after_json     TEXT,
        reason         TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_real_trade_events_record
        ON real_trade_events(record_id, created_at, event_id);
      CREATE INDEX IF NOT EXISTS idx_real_trade_events_char
        ON real_trade_events(character_id, created_at, event_id);

      CREATE TABLE IF NOT EXISTS real_trade_fees (
        fee_id       TEXT PRIMARY KEY,
        record_id    TEXT NOT NULL,
        fee_kind     TEXT NOT NULL CHECK (fee_kind IN ('BROKER', 'TRANSACTION_TAX', 'OTHER', 'MANUAL')),
        amount       REAL NOT NULL CHECK (amount >= 0),
        treatment    TEXT NOT NULL CHECK (treatment IN ('CAPITALIZED', 'SELL_EXPENSE', 'PERIOD_EXPENSE', 'UNRELATED', 'UNKNOWN')),
        evidence_id  TEXT,
        notes        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (record_id, fee_id)
      );
      CREATE INDEX IF NOT EXISTS idx_real_trade_fees_record
        ON real_trade_fees(record_id);

      CREATE TABLE IF NOT EXISTS real_trade_evidence (
        evidence_id    TEXT PRIMARY KEY,
        character_id   INTEGER NOT NULL,
        evidence_type  TEXT NOT NULL CHECK (evidence_type IN ('ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE', 'USER_ATTACHMENT', 'USER_CONFIRMATION')),
        source_system  TEXT NOT NULL,
        source_ref     TEXT,
        captured_at    TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        summary        TEXT,
        metadata_json  TEXT NOT NULL DEFAULT '{}',
        status         TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('VERIFIED', 'USER_REPORTED', 'PENDING', 'CONFLICT', 'REJECTED')),
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_real_trade_evidence_char_time
        ON real_trade_evidence(character_id, captured_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_real_trade_evidence_source
        ON real_trade_evidence(character_id, source_system, source_ref) WHERE source_ref IS NOT NULL;

      CREATE TABLE IF NOT EXISTS real_trade_evidence_links (
        evidence_id  TEXT NOT NULL,
        record_id    TEXT NOT NULL,
        relation     TEXT NOT NULL CHECK (relation IN ('PRIMARY', 'CORROBORATING', 'CONFLICTING', 'ADJUSTMENT')),
        confidence   TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
        notes        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (evidence_id, record_id)
      );

      CREATE TABLE IF NOT EXISTS real_fifo_lots (
        lot_id              TEXT PRIMARY KEY,
        character_id        INTEGER NOT NULL,
        type_id             INTEGER NOT NULL,
        location_id         INTEGER NOT NULL,
        source_record_id    TEXT NOT NULL,
        original_quantity   INTEGER NOT NULL CHECK (original_quantity >= 0),
        remaining_quantity  INTEGER NOT NULL CHECK (remaining_quantity >= 0),
        base_cost           REAL NOT NULL,
        capitalized_fees    REAL NOT NULL DEFAULT 0,
        unit_cost           REAL,
        remaining_cost      REAL,
        cost_status         TEXT NOT NULL CHECK (cost_status IN ('KNOWN', 'PARTIAL', 'UNKNOWN')),
        acquired_at         TEXT NOT NULL,
        calculation_version TEXT NOT NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_real_fifo_lots_fifo
        ON real_fifo_lots(character_id, type_id, location_id, acquired_at, lot_id);

      CREATE TABLE IF NOT EXISTS real_fifo_consumptions (
        consumption_id       TEXT PRIMARY KEY,
        character_id         INTEGER NOT NULL,
        sell_record_id       TEXT NOT NULL,
        lot_id               TEXT NOT NULL,
        type_id              INTEGER NOT NULL,
        location_id          INTEGER NOT NULL,
        quantity             INTEGER NOT NULL CHECK (quantity >= 0),
        unit_cost            REAL,
        allocated_sell_fees  REAL NOT NULL DEFAULT 0,
        realized_pnl         REAL,
        pnl_status           TEXT NOT NULL CHECK (pnl_status IN ('CALCULATED', 'UNKNOWN_COST')),
        calculation_version  TEXT NOT NULL,
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_real_fifo_consumptions_sell
        ON real_fifo_consumptions(character_id, sell_record_id);
      CREATE INDEX IF NOT EXISTS idx_real_fifo_consumptions_lot
        ON real_fifo_consumptions(lot_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_real_fifo_consumptions_unique_consumption
        ON real_fifo_consumptions(sell_record_id, lot_id);

      CREATE TABLE IF NOT EXISTS real_calculation_runs (
        run_id               TEXT PRIMARY KEY,
        character_id         INTEGER NOT NULL,
        calculation_version  TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
        started_at           TEXT NOT NULL,
        completed_at         TEXT,
        record_count         INTEGER NOT NULL DEFAULT 0,
        realized_pnl         REAL,
        unknown_cost_count   INTEGER NOT NULL DEFAULT 0,
        previous_run_id      TEXT,
        before_hash          TEXT,
        after_hash           TEXT,
        differences_json     TEXT NOT NULL DEFAULT '{}',
        error                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_real_calc_runs_char_time
        ON real_calculation_runs(character_id, completed_at);

      CREATE TABLE IF NOT EXISTS real_reconciliation_runs (
        run_id              TEXT PRIMARY KEY,
        character_id        INTEGER NOT NULL,
        snapshot_id         TEXT,
        calculation_run_id  TEXT,
        status              TEXT NOT NULL CHECK (status IN ('MATCHED', 'RECONCILIATION_REQUIRED', 'FAILED')),
        created_at          TEXT NOT NULL,
        completed_at        TEXT,
        summary_json        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_real_recon_runs_char_time
        ON real_reconciliation_runs(character_id, created_at);

      CREATE TABLE IF NOT EXISTS real_reconciliation_items (
        run_id             TEXT NOT NULL,
        reconcile_key      TEXT NOT NULL,
        type_id            INTEGER,
        location_id        INTEGER,
        ledger_quantity    INTEGER NOT NULL DEFAULT 0,
        asset_quantity     INTEGER NOT NULL DEFAULT 0,
        delta_quantity     INTEGER NOT NULL DEFAULT 0,
        ledger_cost        REAL,
        valuation_value    REAL,
        status             TEXT NOT NULL CHECK (status IN ('MATCHED', 'UNMATCHED', 'PARTIAL_MATCH', 'QUANTITY_MISMATCH', 'VALUE_MISMATCH', 'UNKNOWN_SOURCE', 'RECONCILIATION_REQUIRED')),
        reason             TEXT,
        details_json       TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (run_id, reconcile_key)
      );
      CREATE INDEX IF NOT EXISTS idx_real_recon_items_status
        ON real_reconciliation_items(run_id, status);

      CREATE TABLE IF NOT EXISTS real_reconciliation_cases (
        case_id          TEXT PRIMARY KEY,
        run_id           TEXT NOT NULL,
        character_id     INTEGER NOT NULL,
        case_kind        TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
        linked_record_id TEXT,
        linked_change_id TEXT,
        details_json     TEXT NOT NULL DEFAULT '{}',
        resolution       TEXT,
        created_at       TEXT NOT NULL,
        resolved_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_real_recon_cases_run
        ON real_reconciliation_cases(run_id, status);

      CREATE TABLE IF NOT EXISTS real_esi_transaction_sync (
        character_id        INTEGER PRIMARY KEY,
        last_transaction_id INTEGER,
        last_synced_at      TEXT,
        status              TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
        error               TEXT
      );

      DROP TRIGGER IF EXISTS real_trade_records_no_delete;
      CREATE TRIGGER real_trade_records_no_delete
      BEFORE DELETE ON real_trade_records
      BEGIN
        SELECT RAISE(ABORT, '真实交易记录不得直接删除；请使用冲正或更正');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_immutable_facts;
      CREATE TRIGGER real_trade_records_immutable_facts
      BEFORE UPDATE OF trade_kind, direction, type_id, location_id, quantity, unit_price,
        fee_status, trade_time, source_type, source_ref, source_hash, order_id, fill_id,
        execution_status, adjustment_mode, adjustment_amount, target_lot_id,
        from_location_id, to_location_id, is_paper
      ON real_trade_records
      WHEN OLD.record_state <> 'DRAFT'
      BEGIN
        SELECT RAISE(ABORT, '非草稿交易事实不可原地覆盖');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_insert_unverified;
      CREATE TRIGGER real_trade_records_insert_unverified
      BEFORE INSERT ON real_trade_records
      WHEN NEW.record_state = 'VERIFIED' OR NEW.verification_status = 'VERIFIED'
      BEGIN
        SELECT RAISE(ABORT, '交易记录必须先登记再经证据核实');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_draft_cannot_verify;
      CREATE TRIGGER real_trade_records_draft_cannot_verify
      BEFORE UPDATE OF record_state, verification_status ON real_trade_records
      WHEN OLD.record_state = 'DRAFT'
        AND (NEW.record_state = 'VERIFIED' OR NEW.verification_status = 'VERIFIED')
      BEGIN
        SELECT RAISE(ABORT, '草稿必须先提交为待核实申报，再经证据核实');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_verified_no_downgrade;
      CREATE TRIGGER real_trade_records_verified_no_downgrade
      BEFORE UPDATE OF record_state, verification_status ON real_trade_records
      WHEN (OLD.record_state = 'VERIFIED' OR OLD.verification_status = 'VERIFIED')
        AND NOT (
          NEW.record_state = OLD.record_state
          AND NEW.verification_status = OLD.verification_status
        )
        AND NOT (
          NEW.record_state IN ('REVERSED', 'CORRECTED')
          AND NEW.verification_status = 'VERIFIED'
        )
      BEGIN
        SELECT RAISE(ABORT, '已核实交易不可降级；请使用冲正或更正流程');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_fee_adjustment_cannot_verify;
      CREATE TRIGGER real_trade_records_fee_adjustment_cannot_verify
      BEFORE UPDATE OF record_state, verification_status ON real_trade_records
      WHEN NEW.trade_kind = 'FEE_ADJUSTMENT'
        AND (NEW.record_state = 'VERIFIED' OR NEW.verification_status = 'VERIFIED')
      BEGIN
        SELECT RAISE(ABORT, 'FEE_ADJUSTMENT 尚未定义安全的费用归属口径，不能核实');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_verify_matching_evidence;
      CREATE TRIGGER real_trade_records_verify_matching_evidence
      BEFORE UPDATE OF record_state, verification_status ON real_trade_records
      WHEN OLD.record_state = 'ACTIVE'
        AND NEW.record_state = 'VERIFIED' AND NEW.verification_status = 'VERIFIED'
        AND (OLD.record_state <> 'VERIFIED' OR OLD.verification_status <> 'VERIFIED')
        AND NOT EXISTS (
          SELECT 1
          FROM real_trade_evidence_links l
          JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
          WHERE l.record_id = NEW.record_id
            AND e.character_id = NEW.character_id
            AND e.status = 'VERIFIED'
            AND l.relation IN ('PRIMARY', 'CORROBORATING')
            AND (
              (
                NEW.trade_kind IN ('BUY', 'SELL', 'PARTIAL_FILL', 'MULTI_BATCH_FILL')
                AND e.evidence_type = 'ESI_WALLET_LOG'
                AND e.source_system = 'ESI_WALLET_TRANSACTIONS'
                AND e.source_ref IS NOT NULL
                AND (NEW.source_ref IS NULL OR NEW.source_ref NOT LIKE 'esi-wallet:%' OR e.source_ref = NEW.source_ref)
                AND json_valid(e.metadata_json)
                AND CAST(json_extract(e.metadata_json, '$.transactionId') AS TEXT) = substr(e.source_ref, 12)
                AND CAST(json_extract(e.metadata_json, '$.typeId') AS INTEGER) = NEW.type_id
                AND CAST(json_extract(e.metadata_json, '$.quantity') AS INTEGER) = NEW.quantity
                AND ABS(CAST(json_extract(e.metadata_json, '$.unitPrice') AS REAL) - NEW.unit_price) <= 0.005
                AND CAST(json_extract(e.metadata_json, '$.locationId') AS INTEGER) = NEW.location_id
                AND (
                  (json_extract(e.metadata_json, '$.isBuy') = 1 AND NEW.direction = 'BUY')
                  OR (json_extract(e.metadata_json, '$.isBuy') = 0 AND NEW.direction = 'SELL')
                )
                AND datetime(json_extract(e.metadata_json, '$.tradeTime')) = datetime(NEW.trade_time)
              )
              OR (
                NEW.trade_kind = 'INVENTORY_TRANSFER'
                AND e.evidence_type IN ('ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE')
                AND (NEW.source_ref IS NULL OR NEW.source_ref NOT LIKE 'asset-%' OR e.source_ref = NEW.source_ref)
                AND json_valid(e.metadata_json)
                AND CAST(json_extract(e.metadata_json, '$.typeId') AS INTEGER) = NEW.type_id
                AND CAST(json_extract(e.metadata_json, '$.quantity') AS INTEGER) = NEW.quantity
                AND CAST(json_extract(e.metadata_json, '$.fromLocationId') AS INTEGER) = NEW.from_location_id
                AND CAST(json_extract(e.metadata_json, '$.toLocationId') AS INTEGER) = NEW.to_location_id
                AND datetime(COALESCE(json_extract(e.metadata_json, '$.tradeTime'), json_extract(e.metadata_json, '$.capturedAt'))) = datetime(NEW.trade_time)
              )
              OR (
                NEW.trade_kind IN ('FEE_ADJUSTMENT', 'COST_ADJUSTMENT')
                AND e.evidence_type IN ('USER_ATTACHMENT', 'USER_CONFIRMATION')
              )
            )
        )
      BEGIN
        SELECT RAISE(ABORT, '缺少与交易事实完全匹配的已核实 ESI 钱包证据');
      END;

      DROP TRIGGER IF EXISTS real_trade_records_verify_conflicts;
      CREATE TRIGGER real_trade_records_verify_conflicts
      BEFORE UPDATE OF record_state, verification_status ON real_trade_records
      WHEN NEW.record_state = 'VERIFIED' AND NEW.verification_status = 'VERIFIED'
        AND (OLD.record_state <> 'VERIFIED' OR OLD.verification_status <> 'VERIFIED')
        AND EXISTS (
          SELECT 1
          FROM real_trade_evidence_links l
          JOIN real_trade_evidence e ON e.evidence_id = l.evidence_id
          WHERE l.record_id = NEW.record_id
            AND e.character_id = NEW.character_id
            AND e.status IN ('VERIFIED', 'CONFLICT')
            AND l.relation = 'CONFLICTING'
        )
      BEGIN
        SELECT RAISE(ABORT, '存在冲突证据，不能核实交易');
      END;

      DROP TRIGGER IF EXISTS real_trade_events_append_only_update;
      CREATE TRIGGER real_trade_events_append_only_update
      BEFORE UPDATE ON real_trade_events
      BEGIN
        SELECT RAISE(ABORT, '财务事件日志只允许追加');
      END;

      DROP TRIGGER IF EXISTS real_trade_events_append_only_delete;
      CREATE TRIGGER real_trade_events_append_only_delete
      BEFORE DELETE ON real_trade_events
      BEGIN
        SELECT RAISE(ABORT, '财务事件日志只允许追加');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_verified_immutable_update;
      CREATE TRIGGER real_trade_evidence_verified_immutable_update
      BEFORE UPDATE ON real_trade_evidence
      WHEN OLD.status = 'VERIFIED'
      BEGIN
        SELECT RAISE(ABORT, '已核实证据不可原地覆盖');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_verified_immutable_delete;
      CREATE TRIGGER real_trade_evidence_verified_immutable_delete
      BEFORE DELETE ON real_trade_evidence
      WHEN OLD.status = 'VERIFIED'
      BEGIN
        SELECT RAISE(ABORT, '已核实证据不可删除');
      END;

      DROP TRIGGER IF EXISTS real_trade_fees_non_draft_insert;
      CREATE TRIGGER real_trade_fees_non_draft_insert
      BEFORE INSERT ON real_trade_fees
      WHEN COALESCE((SELECT record_state FROM real_trade_records WHERE record_id = NEW.record_id), 'MISSING') <> 'DRAFT'
      BEGIN
        SELECT RAISE(ABORT, '非草稿或孤儿交易的费用不可新增');
      END;

      DROP TRIGGER IF EXISTS real_trade_fees_non_draft_update;
      CREATE TRIGGER real_trade_fees_non_draft_update
      BEFORE UPDATE ON real_trade_fees
      WHEN COALESCE((SELECT record_state FROM real_trade_records WHERE record_id = OLD.record_id), 'MISSING') <> 'DRAFT'
      BEGIN
        SELECT RAISE(ABORT, '非草稿或孤儿交易的费用不可修改');
      END;

      DROP TRIGGER IF EXISTS real_trade_fees_non_draft_delete;
      CREATE TRIGGER real_trade_fees_non_draft_delete
      BEFORE DELETE ON real_trade_fees
      WHEN COALESCE((SELECT record_state FROM real_trade_records WHERE record_id = OLD.record_id), 'MISSING') <> 'DRAFT'
      BEGIN
        SELECT RAISE(ABORT, '非草稿或孤儿交易的费用不可删除');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_links_immutable_insert;
      CREATE TRIGGER real_trade_evidence_links_immutable_insert
      BEFORE INSERT ON real_trade_evidence_links
      WHEN NOT EXISTS (
        SELECT 1 FROM real_trade_records r
        JOIN real_trade_evidence e ON e.evidence_id = NEW.evidence_id AND e.character_id = r.character_id
        WHERE r.record_id = NEW.record_id
      ) OR COALESCE((SELECT record_state FROM real_trade_records WHERE record_id = NEW.record_id), 'MISSING')
        IN ('VERIFIED', 'REVERSED', 'CORRECTED')
      BEGIN
        SELECT RAISE(ABORT, '证据关系必须同角色存在，且已核实或终态记录不可新增证据关系');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_links_single_esi_support_insert;
      CREATE TRIGGER real_trade_evidence_links_single_esi_support_insert
      BEFORE INSERT ON real_trade_evidence_links
      WHEN NEW.relation IN ('PRIMARY', 'CORROBORATING')
        AND EXISTS (
          SELECT 1
          FROM real_trade_evidence e
          JOIN real_trade_evidence_links l ON l.evidence_id = e.evidence_id
          WHERE e.evidence_id = NEW.evidence_id
            AND l.record_id <> NEW.record_id
            AND e.evidence_type IN ('ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE')
        )
      BEGIN
        SELECT RAISE(ABORT, '同一 ESI 证据不能支持多条交易记录');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_links_single_esi_support_update;
      CREATE TRIGGER real_trade_evidence_links_single_esi_support_update
      BEFORE UPDATE OF evidence_id, record_id, relation ON real_trade_evidence_links
      WHEN NEW.relation IN ('PRIMARY', 'CORROBORATING')
        AND EXISTS (
          SELECT 1
          FROM real_trade_evidence e
          JOIN real_trade_evidence_links l ON l.evidence_id = e.evidence_id
          WHERE e.evidence_id = NEW.evidence_id
            AND l.record_id <> NEW.record_id
            AND e.evidence_type IN ('ESI_WALLET_LOG', 'ESI_MARKET_ORDER', 'ESI_ASSET_SNAPSHOT', 'ASSET_CHANGE')
        )
      BEGIN
        SELECT RAISE(ABORT, '同一 ESI 证据不能支持多条交易记录');
      END;

      DROP TRIGGER IF EXISTS real_trade_events_insert_valid_record;
      CREATE TRIGGER real_trade_events_insert_valid_record
      BEFORE INSERT ON real_trade_events
      WHEN NOT EXISTS (
        SELECT 1 FROM real_trade_records WHERE record_id = NEW.record_id AND character_id = NEW.character_id
      )
      BEGIN
        SELECT RAISE(ABORT, '财务事件必须关联同角色交易记录');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_links_immutable_update;
      CREATE TRIGGER real_trade_evidence_links_immutable_update
      BEFORE UPDATE ON real_trade_evidence_links
      WHEN (SELECT record_state FROM real_trade_records WHERE record_id = OLD.record_id)
        IN ('VERIFIED', 'REVERSED', 'CORRECTED')
      BEGIN
        SELECT RAISE(ABORT, '已核实或终态记录不可修改证据关系');
      END;

      DROP TRIGGER IF EXISTS real_trade_evidence_links_immutable_delete;
      CREATE TRIGGER real_trade_evidence_links_immutable_delete
      BEFORE DELETE ON real_trade_evidence_links
      WHEN (SELECT record_state FROM real_trade_records WHERE record_id = OLD.record_id)
        IN ('VERIFIED', 'REVERSED', 'CORRECTED')
      BEGIN
        SELECT RAISE(ABORT, '已核实或终态记录不可删除证据关系');
      END;
    `);
    backfillPaperTradingEscrow(db);
    // Alert push redelivery: per-event attempts with exponential backoff and
    // a terminal abandoned_at so undeliverable events stop blocking the queue.
    addColumnIfMissing(db, 'market_alert_events', 'delivery_attempts', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'market_alert_events', 'next_attempt_at', 'TEXT');
    addColumnIfMissing(db, 'market_alert_events', 'abandoned_at', 'TEXT');
    createIndexIfMissing(db, 'idx_market_alert_events_pending', 'market_alert_events', 'delivered_at, abandoned_at, next_attempt_at');
    ensureUsageTables(db);
    // Вариации карточки предмета фильтруют по group_id: без индекса каждый
    // просмотр вкладки «О предмете» сканировал всю таблицу sde_types (~51k строк).
    createIndexIfMissing(db, 'idx_sde_types_group_id', 'sde_types', 'group_id');
    ensureWebAdmissionEventKinds(db);
    // Perimeter: the map's assistant panel is an ordinary thread, so it needs a
    // kind marker, and its unprompted messages need an anchor (which system,
    // which killmail, which rule) to stay clickable.
    addColumnIfMissing(db, 'agent_threads', 'kind', "TEXT NOT NULL DEFAULT 'chat'");
    addColumnIfMissing(db, 'messages', 'meta_json', 'TEXT');
    createIndexIfMissing(db, 'idx_agent_threads_kind', 'agent_threads', 'chat_id, kind');
    // Gate attribution moved to ingest so camp kills can outlive the short
    // rolling retention; existing rows keep a NULL gate and age out normally.
    addColumnIfMissing(db, 'map_kill_events', 'gate_id', 'INTEGER');
    createIndexIfMissing(db, 'idx_map_kill_events_gate', 'map_kill_events', 'gate_id, killmail_time_ms');
  });

  migrate();
}

function ensureSchema(db: Db): void {
  try {
    db.exec(SCHEMA_SQL);
    return;
  } catch (err) {
    const msg = String((err as Error).message || err);
    // The only tolerated failure is an inline CREATE INDEX in SCHEMA_SQL that
    // references a column a later addColumnIfMissing() adds — happens on legacy
    // DBs whose table predates that column. Anything else is a real error.
    if (!msg.includes('no such column')) throw err;
  }

  // Re-apply statement-by-statement, skipping only the index creations that
  // reference not-yet-added columns. The matching createIndexIfMissing() call
  // recreates them after addColumnIfMissing() runs. All CREATEs use IF NOT
  // EXISTS, so this stays idempotent.
  //
  // Line comments are stripped before splitting: SCHEMA_SQL contains no ';'
  // inside string literals, but a stray one inside a `--` comment used to cut a
  // CREATE TABLE in half here and fail every legacy migration with "incomplete
  // input" — a trap that is invisible at the point where the comment is written.
  const withoutComments = SCHEMA_SQL.replace(/--[^\n]*/g, '');
  for (const raw of withoutComments.split(';')) {
    const stmt = raw.trim();
    if (!stmt) continue;
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = String((err as Error).message || err);
      if (msg.includes('no such column') && /^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(stmt)) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * One-time clean cutover for CLI installations created by the former sentinel
 * lane. Numeric id 1 alone is never evidence: the old adapter wrote this exact
 * account/session marker. Conversation and EVE links move to the explicit
 * local lane; background-only state is removed because the CLI cannot deliver
 * it after the process exits.
 */
function cutoverMarkedLegacyCliIdentity(db: Db): void {
  const alreadyMarked = db.prepare(
    "SELECT 1 FROM cli_accounts WHERE identity_key = 'local'",
  ).get();
  if (alreadyMarked) return;

  const legacy = db.prepare(`
    SELECT a.user_id, s.active_character_id
    FROM telegram_accounts a
    JOIN telegram_sessions s ON s.chat_id = a.telegram_user_id
    WHERE a.telegram_user_id = 1
      AND a.username = 'cli'
      AND a.first_name = 'CLI'
      AND s.username = 'cli'
  `).get() as { user_id: number; active_character_id: number | null } | undefined;
  if (!legacy) return;

  db.prepare(`
    INSERT INTO telegram_sessions (chat_id, username, active_character_id, last_seen_at)
    VALUES (0, 'cli', ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      username = 'cli',
      active_character_id = COALESCE(telegram_sessions.active_character_id, excluded.active_character_id),
      last_seen_at = datetime('now')
  `).run(legacy.active_character_id);
  db.prepare('UPDATE agent_threads SET chat_id = 0, user_id = ? WHERE chat_id = 1')
    .run(legacy.user_id);
  db.prepare(`
    INSERT OR IGNORE INTO eve_character_links (chat_id, character_id, user_id, linked_at)
    SELECT 0, character_id, ?, linked_at
    FROM eve_character_links
    WHERE chat_id = 1
  `).run(legacy.user_id);
  db.prepare('DELETE FROM eve_character_links WHERE chat_id = 1').run();
  db.prepare('UPDATE auth_requests SET chat_id = 0 WHERE chat_id = 1 AND user_id = ?')
    .run(legacy.user_id);

  db.prepare('DELETE FROM kill_watches WHERE chat_id = 1').run();
  db.prepare('DELETE FROM route_monitor_kill_dedup WHERE chat_id = 1').run();
  db.prepare('DELETE FROM route_monitors WHERE chat_id = 1').run();
  db.prepare('DELETE FROM eve_kill_notification_dedup WHERE chat_id = 1').run();
  db.prepare('DELETE FROM heartbeat_config WHERE user_id = ?').run(legacy.user_id);
  db.prepare('DELETE FROM telegram_accounts WHERE telegram_user_id = 1 AND user_id = ?')
    .run(legacy.user_id);
  db.prepare('DELETE FROM telegram_sessions WHERE chat_id = 1').run();
  db.prepare(
    "INSERT INTO cli_accounts (identity_key, user_id, chat_id) VALUES ('local', ?, 0)",
  ).run(legacy.user_id);
}

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  // table_xinfo (not table_info) also lists generated columns.
  const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>;
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function createIndexIfMissing(db: Db, index: string, table: string, columns: string): void {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name = ?"
  ).get(index) as { name: string } | undefined;
  if (row?.name) return;
  db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${columns})`);
}

/**
 * SQLite не умеет ALTER CHECK, поэтому допуск 'ai-search' в web_admission_events
 * приезжает пересборкой таблицы. Свежие БД уже созданы SCHEMA_SQL с новым
 * CHECK — тогда пересборка пропускается по тексту DDL.
 */
function ensureWebAdmissionEventKinds(db: Db): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'web_admission_events'",
  ).get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'ai-search'")) return;
  db.exec(`
    CREATE TABLE web_admission_events_migrated (
      event_id       TEXT PRIMARY KEY,
      event_kind     TEXT NOT NULL CHECK (event_kind IN ('session', 'chat', 'ai-search')),
      user_id        INTEGER,
      ip_key         TEXT NOT NULL,
      cost_units     INTEGER NOT NULL DEFAULT 0,
      created_at_ms  INTEGER NOT NULL
    );
    INSERT INTO web_admission_events_migrated
      SELECT event_id, event_kind, user_id, ip_key, cost_units, created_at_ms
      FROM web_admission_events;
    DROP TABLE web_admission_events;
    ALTER TABLE web_admission_events_migrated RENAME TO web_admission_events;
  `);
  // Индексы умерли вместе со старой таблицей — пересоздаём.
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_admission_events_kind_time ON web_admission_events(event_kind, created_at_ms)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_admission_events_ip_time ON web_admission_events(ip_key, created_at_ms)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_web_admission_events_user_time ON web_admission_events(user_id, created_at_ms)');
}

function ensureConsentLanguageGuards(db: Db): void {
  for (const table of ['auth_requests', 'eve_accounts']) {
    for (const event of ['INSERT', 'UPDATE']) {
      const triggerName = `validate_${table}_consent_language_${event.toLowerCase()}`;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${triggerName}
        BEFORE ${event} ON ${table}
        WHEN NEW.consent_language IS NOT NULL
          AND NEW.consent_language NOT IN ('ru', 'en')
        BEGIN
          SELECT RAISE(ABORT, 'invalid consent_language');
        END
      `);
    }
  }
}

function backfillThreadCharacters(db: Db): void {
  const rows = db.prepare('SELECT thread_id, chat_id, character_id FROM agent_threads').all() as
    Array<{ thread_id: string; chat_id: number; character_id: number | null }>;

  for (const row of rows) {
    if (row.character_id) continue;
    const active = db.prepare('SELECT active_character_id FROM telegram_sessions WHERE chat_id = ?')
      .get(row.chat_id) as { active_character_id: number | null } | undefined;
    if (active?.active_character_id) {
      db.prepare('UPDATE agent_threads SET character_id = ? WHERE thread_id = ?')
        .run(active.active_character_id, row.thread_id);
    }
  }
}

function backfillUsers(db: Db): void {
  // Legacy backfill for pre-user_id Telegram DBs. Telegram private chat ids are
  // positive; Discord DM lanes reuse telegram_sessions with NEGATIVE chat keys
  // and 0 is the local CLI lane (formerly a web placeholder) — neither is a Telegram user, so excluding
  // chat_id <= 0 prevents fabricating a bogus telegram_account (with a negative
  // telegram_user_id) for every Discord lane on each boot.
  const sessions = db.prepare('SELECT chat_id, username, active_character_id FROM telegram_sessions WHERE chat_id > 0').all() as
    Array<{ chat_id: number; username: string | null; active_character_id: number | null }>;

  for (const session of sessions) {
    const existing = db.prepare('SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?')
      .get(session.chat_id) as { user_id: number } | undefined;
    if (existing) continue;

    const displayName = session.username || `tg:${session.chat_id}`;
    const result = db.prepare(
      "INSERT INTO users (display_name, active_character_id, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
    ).run(displayName, session.active_character_id);
    const userId = Number(result.lastInsertRowid);

    db.prepare(
      "INSERT INTO telegram_accounts (telegram_user_id, user_id, username, first_name, created_at) VALUES (?, ?, ?, '', datetime('now'))",
    ).run(session.chat_id, userId, session.username ?? '');

    // Backfill user_id in eve_character_links
    db.prepare('UPDATE eve_character_links SET user_id = ? WHERE chat_id = ? AND user_id IS NULL')
      .run(userId, session.chat_id);

    // Backfill user_id in agent_threads
    db.prepare('UPDATE agent_threads SET user_id = ? WHERE chat_id = ? AND user_id IS NULL')
      .run(userId, session.chat_id);
  }

  // Backfill user_id in eve_accounts from eve_character_links
  db.prepare(`
    UPDATE eve_accounts SET user_id = (
      SELECT l.user_id FROM eve_character_links l
      WHERE l.character_id = eve_accounts.character_id AND l.user_id IS NOT NULL
      LIMIT 1
    ) WHERE user_id IS NULL
  `).run();
}

function ensureHeartbeatConfig(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='heartbeat_config'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE heartbeat_config (
        user_id          INTEGER NOT NULL,
        character_id     INTEGER NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 0,
        interval_seconds INTEGER NOT NULL DEFAULT 3600,
        checks_json      TEXT NOT NULL DEFAULT '["mail"]',
        last_run_at      TEXT,
        last_mail_id     INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, character_id)
      )
    `);
  }
}

function ensureKillWatches(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kill_watches'",
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE kill_watches (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     INTEGER NOT NULL,
        topic       TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(chat_id, topic)
      )
    `);
    db.exec('CREATE INDEX idx_kill_watches_chat ON kill_watches(chat_id)');
  }
}

function ensureEveKillFeedState(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eve_kill_feed_state (
      feed_key         TEXT PRIMARY KEY CHECK (feed_key = 'global'),
      last_sequence_id INTEGER NOT NULL CHECK (last_sequence_id >= 0),
      dedup_pruned_at  TEXT,
      initialized_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS eve_kill_notification_dedup (
      chat_id       INTEGER NOT NULL,
      killmail_id   INTEGER NOT NULL,
      sequence_id   INTEGER NOT NULL,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, killmail_id)
    );
    CREATE INDEX IF NOT EXISTS idx_eve_kill_notification_dedup_sequence
      ON eve_kill_notification_dedup(sequence_id);
    CREATE INDEX IF NOT EXISTS idx_eve_kill_notification_dedup_delivered
      ON eve_kill_notification_dedup(delivered_at);
    CREATE TABLE IF NOT EXISTS eve_kill_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  addColumnIfMissing(db, 'eve_kill_feed_state', 'dedup_pruned_at', 'TEXT');
}

function removeLegacyRouteWatchesOnce(db: Db): void {
  const migrationKey = 'remove-legacy-route-watches-v1';
  const applied = db.prepare(
    'SELECT 1 FROM eve_kill_migrations WHERE migration_key = ?',
  ).get(migrationKey);
  if (applied) return;
  db.prepare("DELETE FROM kill_watches WHERE label LIKE '[route] %'").run();
  db.prepare('INSERT INTO eve_kill_migrations (migration_key) VALUES (?)').run(migrationKey);
}

function ensureRouteMonitors(db: Db): void {
  const hasMonitors = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='route_monitors'",
  ).get();
  if (!hasMonitors) {
    db.exec(`
      CREATE TABLE route_monitors (
        chat_id            INTEGER PRIMARY KEY,
        character_id       INTEGER NOT NULL,
        origin_id          INTEGER NOT NULL,
        destination_id     INTEGER NOT NULL,
        route_systems      TEXT NOT NULL DEFAULT '[]',
        current_system_id  INTEGER,
        ship_type_id       INTEGER,
        ship_name          TEXT DEFAULT '',
        ship_ehp           REAL DEFAULT 0,
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_location_check TEXT,
        last_online_check  TEXT,
        stats_json         TEXT NOT NULL DEFAULT '{}',
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  const hasGankerCache = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='route_ganker_cache'",
  ).get();
  if (!hasGankerCache) {
    db.exec(`
      CREATE TABLE route_ganker_cache (
        character_id     INTEGER NOT NULL,
        system_id        INTEGER NOT NULL,
        character_name   TEXT DEFAULT '',
        kill_count       INTEGER DEFAULT 1,
        last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
        ship_type_id     INTEGER,
        PRIMARY KEY (character_id, system_id)
      )
    `);
  }
}

function ensureRouteMonitorKillDedup(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_monitor_kill_dedup (
      chat_id           INTEGER NOT NULL,
      monitor_started_at TEXT NOT NULL,
      killmail_id       INTEGER NOT NULL,
      sequence_id       INTEGER NOT NULL,
      processed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, monitor_started_at, killmail_id)
    );
    CREATE INDEX IF NOT EXISTS idx_route_monitor_kill_dedup_processed
      ON route_monitor_kill_dedup(processed_at);
  `);
}

function ensureIntelNotes(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='intel_notes'",
  ).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE intel_notes (
        note_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        system_id    INTEGER,
        system_name  TEXT,
        region_id    INTEGER,
        region_name  TEXT,
        entity_name  TEXT,
        tag          TEXT NOT NULL DEFAULT 'general',
        text         TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX idx_intel_notes_user ON intel_notes(user_id)');
    db.exec('CREATE INDEX idx_intel_notes_system ON intel_notes(user_id, system_id)');
    db.exec('CREATE INDEX idx_intel_notes_region ON intel_notes(user_id, region_id)');
  }
}

function ensureProcessedUpdates(db: Db): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_processed_updates'",
  ).get();
  if (!exists) {
    // Claimed before dispatch so a redelivered update (the process died before
    // long polling confirmed the offset) is not handled twice.
    db.exec(`
      CREATE TABLE telegram_processed_updates (
        update_id    INTEGER PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX idx_telegram_processed_updates_at ON telegram_processed_updates(processed_at)');
  }
}

/**
 * Token spend accounting. Raw per-response events live in usage_events and are
 * pruned by age after rollup; usage_daily keeps compact aggregates forever.
 * Money is integer microdollars, never REAL. cost_micros is NULL when the
 * model had no configured tariff — an unknown cost must never read as 0
 * ("free"). usage_daily carries user_id so the logged-in "my spend" row stays
 * answerable after raw events are gone; public reads always aggregate over
 * every user and never expose a per-user row.
 */
function ensureUsageTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms      INTEGER NOT NULL,
      user_id            INTEGER NOT NULL,
      thread_id          TEXT NOT NULL,
      channel            TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'discord', 'cli')),
      model              TEXT NOT NULL,
      input_tokens       INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens      INTEGER NOT NULL CHECK (output_tokens >= 0),
      cached_tokens      INTEGER NOT NULL CHECK (cached_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
      reasoning_tokens   INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
      cost_micros        INTEGER CHECK (cost_micros >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events(user_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS usage_daily (
      day                 TEXT NOT NULL,
      channel             TEXT NOT NULL,
      model               TEXT NOT NULL,
      user_id             INTEGER NOT NULL,
      events              INTEGER NOT NULL CHECK (events > 0),
      input_tokens        INTEGER NOT NULL,
      output_tokens       INTEGER NOT NULL,
      cached_tokens       INTEGER NOT NULL,
      cache_write_tokens  INTEGER NOT NULL,
      reasoning_tokens    INTEGER NOT NULL,
      cost_micros         INTEGER NOT NULL,
      unknown_cost_events INTEGER NOT NULL,
      PRIMARY KEY (day, channel, model, user_id)
    );
  `);
}

function clearLegacyOauthStates(db: Db): void {
  db.prepare('UPDATE telegram_sessions SET oauth_state = NULL WHERE oauth_state IS NOT NULL').run();
}

function ensureWebSessions(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(web_sessions)').all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((column) => column.name === 'session_hash')) {
    // Clean cutover from the removed dashboard's incompatible session table.
    db.exec('DROP TABLE web_sessions');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      session_hash TEXT PRIMARY KEY,
      csrf_hash    TEXT NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES users(user_id),
      chat_id      INTEGER NOT NULL UNIQUE REFERENCES telegram_sessions(chat_id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
  `);
  db.exec('DROP TABLE IF EXISTS telegram_login_attempts');
}

function ensureWebAgentRequests(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_agent_requests (
      request_id       TEXT PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(user_id),
      chat_id          INTEGER NOT NULL REFERENCES telegram_sessions(chat_id),
      thread_id        TEXT NOT NULL REFERENCES agent_threads(thread_id) ON DELETE CASCADE,
      character_id     INTEGER,
      character_version INTEGER NOT NULL,
      message          TEXT NOT NULL,
      message_hash     TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      activity_json    TEXT NOT NULL DEFAULT '[]',
      progress_sequence INTEGER NOT NULL DEFAULT 0,
      stream_text      TEXT NOT NULL DEFAULT '',
      result_text      TEXT,
      assistant_message_id INTEGER,
      error_code       TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      cost_reserved    INTEGER NOT NULL DEFAULT 1,
      cost_actual      INTEGER NOT NULL DEFAULT 0,
      created_at_ms    INTEGER NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      started_at       TEXT,
      heartbeat_at     TEXT,
      lease_expires_at TEXT,
      finished_at      TEXT,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  addColumnIfMissing(db, 'web_agent_requests', 'character_id', 'INTEGER');
  addColumnIfMissing(db, 'web_agent_requests', 'character_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_agent_requests', 'idempotency_key', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'web_agent_requests', 'progress_sequence', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_agent_requests', 'assistant_message_id', 'INTEGER');
  addColumnIfMissing(db, 'web_agent_requests', 'cost_reserved', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'web_agent_requests', 'cost_actual', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'web_agent_requests', 'heartbeat_at', 'TEXT');
  addColumnIfMissing(db, 'web_agent_requests', 'lease_expires_at', 'TEXT');
  addColumnIfMissing(db, 'web_agent_requests', 'stream_text', "TEXT NOT NULL DEFAULT ''");
  db.prepare(`
    UPDATE web_agent_requests SET idempotency_key = request_id WHERE idempotency_key = ''
  `).run();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_agent_requests_status
      ON web_agent_requests(status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_agent_requests_actor
      ON web_agent_requests(user_id, chat_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_agent_requests_thread
      ON web_agent_requests(thread_id, created_at_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_web_agent_requests_idempotency
      ON web_agent_requests(user_id, chat_id, idempotency_key);
    CREATE TABLE IF NOT EXISTS web_admission_events (
      event_id       TEXT PRIMARY KEY,
      event_kind     TEXT NOT NULL CHECK (event_kind IN ('session', 'chat')),
      user_id        INTEGER,
      ip_key         TEXT NOT NULL,
      cost_units     INTEGER NOT NULL DEFAULT 0,
      created_at_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_admission_events_kind_time
      ON web_admission_events(event_kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_admission_events_ip_time
      ON web_admission_events(ip_key, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_web_admission_events_user_time
      ON web_admission_events(user_id, created_at_ms);
  `);
  // --- Trading System Extensions (P1-P7) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_source_status (
      source_id       TEXT PRIMARY KEY,
      status          TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'offline')),
      last_success_at TEXT,
      last_error      TEXT,
      error_count_1h  INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portfolio_positions (
      position_id     TEXT PRIMARY KEY,
      character_id    INTEGER NOT NULL,
      type_id         INTEGER NOT NULL,
      location_id     INTEGER NOT NULL,
      quantity        INTEGER NOT NULL,
      cost_basis      REAL NOT NULL,
      current_price   REAL,
      unrealized_pnl  REAL,
      strategy_type   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'closed')),
      opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_portfolio_char_status
      ON portfolio_positions(character_id, status);

    CREATE TABLE IF NOT EXISTS trade_drafts (
      draft_id        TEXT PRIMARY KEY,
      character_id    INTEGER NOT NULL,
      type_id         INTEGER NOT NULL,
      strategy        TEXT NOT NULL,
      buy_station_id  INTEGER NOT NULL,
      sell_station_id INTEGER NOT NULL,
      suggested_buy   REAL NOT NULL,
      suggested_qty   INTEGER NOT NULL,
      suggested_sell  REAL NOT NULL,
      estimated_fees  REAL NOT NULL,
      hauling_cost    REAL NOT NULL DEFAULT 0,
      expected_profit REAL NOT NULL,
      expected_roi    REAL NOT NULL,
      capital_required REAL NOT NULL,
      turnover_hours  REAL,
      status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'executed_manually', 'expired', 'closed', 'audit_revoked')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT NOT NULL,
      executed_at     TEXT,
      actual_buy_price REAL,
      actual_sell_price REAL,
      actual_profit   REAL,
      revoked_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trade_drafts_char_status
      ON trade_drafts(character_id, status);

    CREATE TABLE IF NOT EXISTS trade_ledger (
      ledger_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id        TEXT,
      character_id    INTEGER NOT NULL,
      type_id         INTEGER NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'reprocess', 'broker_fee', 'sales_tax', 'relist_fee')),
      quantity        INTEGER NOT NULL,
      price           REAL NOT NULL,
      fees            REAL NOT NULL DEFAULT 0,
      timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
      notes           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trade_ledger_char_time
      ON trade_ledger(character_id, timestamp);

    CREATE TABLE IF NOT EXISTS risk_snapshots (
      snapshot_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id        INTEGER NOT NULL,
      total_equity        REAL NOT NULL,
      cash_reserve        REAL NOT NULL,
      invested_capital    REAL NOT NULL,
      single_item_max_pct REAL NOT NULL,
      category_max_pct    REAL NOT NULL,
      var_95              REAL,
      cvar_95             REAL,
      recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backtest_runs (
      run_id          TEXT PRIMARY KEY,
      strategy_name   TEXT NOT NULL,
      time_horizon    TEXT NOT NULL,
      initial_capital REAL NOT NULL,
      final_capital   REAL NOT NULL,
      total_roi_pct   REAL NOT NULL,
      max_drawdown_pct REAL NOT NULL,
      sharpe_ratio    REAL,
      win_rate_pct    REAL NOT NULL,
      trade_count     INTEGER NOT NULL,
      fee_drag_pct    REAL NOT NULL,
      metrics_json    TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_trading_positions (
      paper_id        TEXT PRIMARY KEY,
      character_id    INTEGER NOT NULL,
      type_id         INTEGER NOT NULL,
      location_id     INTEGER NOT NULL,
      quantity        INTEGER NOT NULL,
      cost_price      REAL NOT NULL,
      status          TEXT NOT NULL DEFAULT 'holding' CHECK (status IN ('holding', 'sold')),
      strategy_type   TEXT NOT NULL DEFAULT 'regional_hauling',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      sold_at         TEXT,
      sold_price      REAL,
      realized_pnl    REAL
    );

    CREATE TABLE IF NOT EXISTS paper_trading_accounts (
      account_id          TEXT PRIMARY KEY,
      character_id        INTEGER NOT NULL,
      initial_cash        REAL NOT NULL DEFAULT 10000000,
      available_cash      REAL NOT NULL DEFAULT 10000000,
      escrow_locked       REAL NOT NULL DEFAULT 0,
      total_realized_pnl  REAL NOT NULL DEFAULT 0,
      total_fees_paid     REAL NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trade_opportunities_log (
      opportunity_id      TEXT PRIMARY KEY,
      strategy_type       TEXT NOT NULL,
      type_id             INTEGER NOT NULL,
      region_id           INTEGER NOT NULL,
      detected_at         TEXT NOT NULL DEFAULT (datetime('now')),
      expected_buy_price  REAL NOT NULL,
      expected_sell_price REAL NOT NULL,
      proposed_quantity   INTEGER NOT NULL,
      expected_fees       REAL NOT NULL,
      expected_net_profit REAL NOT NULL,
      expected_roi        REAL NOT NULL,
      risk_rating         TEXT NOT NULL,
      rejection_reason    TEXT,
      data_quality_json   TEXT,
      outcome_status      TEXT NOT NULL DEFAULT 'pending' CHECK (outcome_status IN ('pending', 'simulated_filled', 'vetoed', 'expired', 'simulated_partial')),
      actual_simulated_pnl REAL,
      prediction_variance  REAL
    );

    CREATE TABLE IF NOT EXISTS paper_trading_orders (
      order_id            TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL,
      opportunity_id      TEXT,
      idempotency_key     TEXT UNIQUE,
      character_id        INTEGER NOT NULL,
      type_id             INTEGER NOT NULL,
      strategy_type       TEXT NOT NULL DEFAULT 'regional_hauling',
      order_type          TEXT NOT NULL CHECK (order_type IN ('buy', 'sell')),
      price               REAL NOT NULL,
      quantity            INTEGER NOT NULL,
      filled_quantity     INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_filled', 'filled', 'cancelled', 'expired')),
      fees_paid           REAL NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_orders_idempotency
      ON paper_trading_orders(idempotency_key);

    CREATE TABLE IF NOT EXISTS paper_trading_journal (
      journal_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id        TEXT NOT NULL,
      order_id          TEXT,
      entry_type        TEXT NOT NULL CHECK (entry_type IN ('deposit', 'escrow_lock', 'escrow_release', 'fee_payment', 'realized_pnl', 'order_spend', 'order_revenue')),
      amount            REAL NOT NULL,
      balance_after     REAL NOT NULL,
      escrow_after      REAL NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_paper_journal_account
      ON paper_trading_journal(account_id, created_at);

    CREATE TABLE IF NOT EXISTS consumed_pipeline_credentials (
      credential_id   TEXT PRIMARY KEY,
      character_id    INTEGER NOT NULL,
      draft_id        TEXT NOT NULL,
      consumed_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_consumed_cred_char 
      ON consumed_pipeline_credentials(character_id, consumed_at);
  `);

    addColumnIfMissing(db, 'paper_trading_positions', 'strategy_type', "TEXT NOT NULL DEFAULT 'regional_hauling'");
}

async function main(): Promise<void> {
  const { initDb } = await import('./sqlite.js');
  const { config } = await import('../config.js');
  const db = initDb(config.db.path);
  runMigrations(db);
  db.close();
  console.log('[migrations] Done');
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main();
}




