import { invoke } from "@tauri-apps/api/core";
import type { SshAuthKind } from "@/shared/sshApi";

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: SshAuthKind;
  privateKeyPath: string;
  /** 是否记住密码/口令（存于 ~/.prismcode/ssh-credentials.json） */
  rememberSecret?: boolean;
}

export interface SshSecret {
  password?: string;
  passphrase?: string;
}

/** 旧版 localStorage 主机列表，启动时迁移至磁盘后删除 */
const LEGACY_PROFILES_KEY = "prismcode.sshProfiles.v1";
const LEGACY_PROFILES_KEY_MIRO = "mirocode.sshProfiles.v1";
/** 旧版 localStorage 密文，启动时迁移后删除 */
const LEGACY_SECRETS_KEY = "prismcode.sshSecrets.v1";
const LEGACY_SECRETS_KEY_MIRO = "mirocode.sshSecrets.v1";

let migratePromise: Promise<void> | null = null;

async function migrateLegacyProfiles(): Promise<void> {
  try {
    const disk = await invoke<SshProfile[]>("ssh_profiles_load");
    if (disk.length > 0) {
      localStorage.removeItem(LEGACY_PROFILES_KEY);
      return;
    }
    const raw =
      localStorage.getItem(LEGACY_PROFILES_KEY) ??
      localStorage.getItem(LEGACY_PROFILES_KEY_MIRO);
    if (!raw) return;
    const parsed = JSON.parse(raw) as SshProfile[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.removeItem(LEGACY_PROFILES_KEY);
      return;
    }
    await invoke("ssh_profiles_save", { profiles: parsed.slice(0, 20) });
    localStorage.removeItem(LEGACY_PROFILES_KEY);
  } catch {
    // 迁移失败保留旧数据，下次再试
  }
}

async function migrateLegacySecrets(): Promise<void> {
  try {
    const raw =
      localStorage.getItem(LEGACY_SECRETS_KEY) ??
      localStorage.getItem(LEGACY_SECRETS_KEY_MIRO);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, SshSecret>;
    if (!parsed || typeof parsed !== "object") {
      localStorage.removeItem(LEGACY_SECRETS_KEY);
      return;
    }
    for (const [profileId, secret] of Object.entries(parsed)) {
      if (!secret?.password && !secret?.passphrase) continue;
      await invoke("ssh_secret_set", {
        profileId,
        secret: {
          password: secret.password ?? null,
          passphrase: secret.passphrase ?? null,
        },
      });
    }
    localStorage.removeItem(LEGACY_SECRETS_KEY);
  } catch {
    // 迁移失败保留旧数据，下次再试
  }
}

async function ensureMigrated(): Promise<void> {
  if (migratePromise) return migratePromise;
  migratePromise = (async () => {
    await migrateLegacyProfiles();
    await migrateLegacySecrets();
  })();
  return migratePromise;
}

/** 应用级全局主机列表（~/.prismcode/ssh-profiles.json，与工作区/窗口无关） */
export async function loadSshProfiles(): Promise<SshProfile[]> {
  await ensureMigrated();
  try {
    const profiles = await invoke<SshProfile[]>("ssh_profiles_load");
    return Array.isArray(profiles) ? profiles : [];
  } catch {
    return [];
  }
}

export async function saveSshProfiles(profiles: SshProfile[]) {
  await ensureMigrated();
  await invoke("ssh_profiles_save", { profiles: profiles.slice(0, 20) });
}

export async function upsertSshProfile(profile: SshProfile) {
  const list = (await loadSshProfiles()).filter((p) => p.id !== profile.id);
  list.unshift(profile);
  await saveSshProfiles(list);
}

export async function removeSshProfile(id: string) {
  await saveSshProfiles((await loadSshProfiles()).filter((p) => p.id !== id));
  void removeSshSecret(id);
}

export async function getSshSecret(profileId: string): Promise<SshSecret | null> {
  await ensureMigrated();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const secret = await invoke<SshSecret | null>("ssh_secret_get", { profileId });
      if (!secret) return null;
      if (!secret.password && !secret.passphrase) return null;
      return secret;
    } catch {
      if (attempt === 0) {
        await new Promise((r) => window.setTimeout(r, 80));
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function setSshSecret(profileId: string, secret: SshSecret): Promise<void> {
  await ensureMigrated();
  await invoke("ssh_secret_set", {
    profileId,
    secret: {
      password: secret.password || null,
      passphrase: secret.passphrase || null,
    },
  });
}

export async function removeSshSecret(profileId: string): Promise<void> {
  await ensureMigrated();
  try {
    await invoke("ssh_secret_remove", { profileId });
  } catch {
    // 忽略
  }
}

export function createEmptyProfile(): SshProfile {
  return {
    id: `profile-${Date.now()}`,
    name: "",
    host: "",
    port: 22,
    username: "",
    authKind: "password",
    privateKeyPath: "~/.ssh/id_ed25519",
    rememberSecret: true,
  };
}
