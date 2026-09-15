/** Host ownership is explicit; container user IDs are never assumed. */
export type Owner = [uid: number, gid: number];

export interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ContentMetadata {
  path: string;
  uid: number;
  gid: number;
  mode: number;
}

export type DatabaseCounts = Record<string, Record<string, string>>;

export interface Checkpoint {
  format: 'ghost-docker-recovery';
  version: 1;
  createdAt: string;
  manager: string;
  project: string;
  images: Record<string, string>;
  counts: DatabaseCounts;
  restartPolicy: string;
  contentMetadata: ContentMetadata[];
  databases: string[];
  databaseBytes: number;
  profiles: string;
  limitations: string[];
  files: FileEntry[];
}

export interface RestoreOptions {
  project: string;
  port: number;
  local: boolean;
}

export type Phase =
  | 'freezing'
  | 'snapshotting'
  | 'resuming'
  | 'preparing'
  | 'restoring'
  | 'verifying'
  | 'verified'
  | 'activating';

interface JournalBase {
  version: 1;
  daemon: string;
  id: string;
  manager: string;
  phase: Phase;
  updatedAt: string;
  error?: string;
}

export interface BackupJournal extends JournalBase {
  kind: 'backup';
  project: string;
  checkpoint: string;
  staging: string;
  running: { id: string; running: boolean; restart: string }[];
}

export interface RestoreJournal extends JournalBase {
  kind: 'restore';
  sourcePath: string;
  checkpointHash: string;
  restartPolicy: string;
  options: RestoreOptions;
}

export type Journal = BackupJournal | RestoreJournal;
export type NewJournal =
  | Omit<BackupJournal, 'version' | 'daemon' | 'updatedAt'>
  | Omit<RestoreJournal, 'version' | 'daemon' | 'updatedAt'>;

/** The subset of Docker's inspect/config output consumed by the manager. */
export interface Container {
  Id: string;
  Image: string;
  Config: { Labels: Record<string, string> };
  HostConfig: { RestartPolicy: { Name: string } };
  State: { Running: boolean; Status: string; Health?: { Status: string } };
  NetworkSettings: { Networks: Record<string, unknown> };
}

export interface Image {
  Id: string;
  RepoDigests?: string[];
}

export interface Service {
  image: string;
  restart?: string;
  environment: Record<string, string>;
  volumes: { type: string; source: string; target: string }[];
}

export interface ComposeConfig {
  name: string;
  services: Record<string, Service>;
}

export interface DatabaseConnection {
  names: string[];
  env: { MYSQL_PWD: string };
}

export interface SiteState {
  config: ComposeConfig;
  content: string;
  database: string;
  db: DatabaseConnection;
}

export interface SiteMetadata {
  site?: Record<string, unknown>;
  mode?: string;
  profiles?: string[];
  manager?: { image: string };
  [key: string]: unknown;
}
