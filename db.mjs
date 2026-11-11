import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = process.env.FACE_ATTENDANCE_DB || path.join(DATA_DIR, 'attendance.sqlite');

export function openDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY,
      student_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      portrait_data TEXT,
      classroom_id INTEGER REFERENCES classrooms(id) ON DELETE RESTRICT,
      grade TEXT NOT NULL,
      room TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS classrooms (
      id INTEGER PRIMARY KEY,
      grade TEXT NOT NULL,
      room TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      UNIQUE(grade,room)
    );
    CREATE TABLE IF NOT EXISTS face_consents (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('granted','revoked')),
      version TEXT NOT NULL,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS face_consents_student_latest ON face_consents(student_id, id DESC);
    CREATE TABLE IF NOT EXISTS face_templates (
      student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE RESTRICT,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      model_version TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS attendance_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      starts_at TEXT NOT NULL DEFAULT '08:00',
      late_after TEXT NOT NULL DEFAULT '08:15',
      match_threshold REAL NOT NULL DEFAULT 0.88 CHECK(match_threshold >= 0.5 AND match_threshold <= 0.99),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT OR IGNORE INTO attendance_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
      attendance_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('present','late','absent','excused')),
      checked_at TEXT,
      source TEXT NOT NULL CHECK(source IN ('manual','face-reviewed','edit')),
      confidence REAL,
      reviewed_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(student_id, attendance_date)
    );
    CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance_records(attendance_date, status);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
  `);
  const studentColumns=new Set(db.prepare('PRAGMA table_info(students)').all().map(column=>column.name));
  if(!studentColumns.has('portrait_data'))db.exec('ALTER TABLE students ADD COLUMN portrait_data TEXT');
  return db;
}

export function audit(db, actorId, action, entity, entityId, details = {}) {
  db.prepare('INSERT INTO audit_logs(actor_id, action, entity, entity_id, details) VALUES(?,?,?,?,?)')
    .run(actorId, action, entity, String(entityId), JSON.stringify(details));
}
