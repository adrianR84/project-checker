/**
 * @fileoverview Shared JSDoc typedefs for all JSON-serialized column shapes.
 * These types describe the runtime structure of fields stored as JSON strings in SQLite.
 * Use @type annotations at parse sites to catch missing-property errors at edit time.
 */

/**
 * @typedef {Object} ProjectWebsite
 * @property {string}    url  — website URL
 * @property {0|1}      [cc] — content-check enabled (default 1)
 */

/**
 * @typedef {Object} ProjectGithub
 * @property {string} url — GitHub org/repo URL
 */

/**
 * @typedef {Object} ProjectTwitter
 * @property {string}  url — Twitter/X profile URL
 * @property {0|1}    [pc] — posts-check enabled (default 1)
 */

/**
 * @typedef {Object} ProjectTelegram
 * @property {string} url — Telegram profile URL
 */

/**
 * @typedef {Object} ProjectToken
 * @property {string} [symbol]
 * @property {string} [contract]
 * @property {string} [chain]
 */

/**
 * @typedef {Object} ConfigSettings
 * @property {number}  log_retention_days
 * @property {number}  event_log_retention_days
 * @property {number}  alert_log_retention_days
 * @property {number}  twitter_posts_per_project
 * @property {number}  ui_refresh_seconds
 * @property {number}  compact_activity_display
 * @property {string|null} github_token
 * @property {string|null} api_token
 * @property {number}  logs_per_page
 * @property {number}  checks_on_new_project
 * @property {number}  system_pause
 */

/**
 * @typedef {Object} PriceAlert
 * @property {string}  price_for      — e.g. "6h"
 * @property {number}  price_change   — threshold percentage
 * @property {number}  price_interval — minutes between repeated alerts
 * @property {0|1}     enabled
 * @property {0|1}     telegram
 * @property {0|1}     pushbullet
 * @property {0|1}     log
 */

/**
 * @typedef {Object} ConfigPriceAlerts
 * @property {PriceAlert[]} alerts
 */

/**
 * @typedef {Object} ConfigTelegram
 * @property {string}  bot_token
 * @property {string}  chat_id
 * @property {0|1}    enabled
 */

/**
 * @typedef {Object} ConfigPushbullet
 * @property {string}  access_token
 * @property {0|1}     enabled
 */

/**
 * @typedef {Object} ConfigWebshare
 * @property {0|1}     enabled
 * @property {string|null} token
 * @property {string}  country
 */

/**
 * @typedef {Object} CheckResult
 * @property {'ok'|'error'|'disabled'|'unavailable'|'deleted'|'changed'} status
 * @property {number|null}  http_status
 * @property {number}       response_time_ms
 * @property {string|null}  error_message
 * @property {Object|null}  [details] — shape varies by check type:
 *   website: { content_hash: string }
 *   github:  { changed?, previous_sha?, new_sha?, tag_changed?, old_tag?, new_tag? }
 *   twitter: { new_posts?, post_ids? } | { suspended_detected: true }
 */

/**
 * @typedef {Object} EventLog
 * @property {number} id
 * @property {number} project_id
 * @property {'website'|'github'|'twitter'} resource_type
 * @property {'changed'|'deleted'|'tag_changed'} event_type
 * @property {string} value — JSON string
 * @property {string} created_at
 * @property {0|1}   confirmed
 */
