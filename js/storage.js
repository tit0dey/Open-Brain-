/**
 * KDP Studio — Offline Project Persistence & JSON Export/Import
 *
 * Persists the active project and UI theme in localStorage and provides
 * schema-validated .json export/import for portable backups on Android.
 */

import { createDemoProject } from './demo-project.js';

export const PROJECT_STORAGE_KEY = 'kdp_studio_project_v1';
export const THEME_STORAGE_KEY = 'kdp_studio_theme_v1';

/**
 * Deep-merge a loaded/imported object onto the canonical project structure so
 * missing keys from older or partial JSON exports never break runtime code.
 */
export function normalizeProject(raw) {
  const base = createDemoProject();
  if (!raw || typeof raw !== 'object') return base;

  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    bookMeta: {
      ...base.bookMeta,
      ...(raw.bookMeta && typeof raw.bookMeta === 'object' ? raw.bookMeta : {})
    },
    manuscriptText:
      typeof raw.manuscriptText === 'string' ? raw.manuscriptText : base.manuscriptText,
    layout: {
      ...base.layout,
      ...(raw.layout && typeof raw.layout === 'object' ? raw.layout : {})
    },
    cover: {
      ...base.cover,
      ...(raw.cover && typeof raw.cover === 'object' ? raw.cover : {})
    },
    spineConstants: {
      ...base.spineConstants,
      ...(raw.spineConstants && typeof raw.spineConstants === 'object' ? raw.spineConstants : {})
    },
    listing: {
      ...base.listing,
      ...(raw.listing && typeof raw.listing === 'object' ? raw.listing : {}),
      keywords: Array.isArray(raw.listing?.keywords)
        ? Array.from({ length: 7 }, (_, i) => String(raw.listing.keywords[i] ?? ''))
        : base.listing.keywords,
      categories: Array.isArray(raw.listing?.categories)
        ? raw.listing.categories.slice(0, 3).map(String)
        : base.listing.categories
    }
  };
}

export function loadProjectFromStorage() {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) {
      return { project: createDemoProject(), isFirstLoad: true };
    }
    const parsed = JSON.parse(raw);
    return { project: normalizeProject(parsed), isFirstLoad: false };
  } catch {
    return { project: createDemoProject(), isFirstLoad: true };
  }
}

export function saveProjectToStorage(project) {
  try {
    const payload = {
      ...project,
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(payload));
    return { saved: true };
  } catch (err) {
    // If a large uploaded cover image exceeds quota, retry saving without image data
    try {
      const slim = {
        ...project,
        cover: { ...project.cover, frontImageDataUrl: null },
        updatedAt: new Date().toISOString()
      };
      localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(slim));
      return { saved: true, omittedImage: true };
    } catch {
      return { saved: false, error: err?.message || 'Storage quota exceeded' };
    }
  }
}

export function slugifyFilename(title) {
  const slug = String(title || 'kdp-book')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'kdp-book';
}

export function serializeProjectJson(project) {
  return JSON.stringify(
    {
      app: 'KDP Studio',
      version: 1,
      exportedAt: new Date().toISOString(),
      ...project
    },
    null,
    2
  );
}

export function parseImportedProjectJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || (!data.manuscriptText && !data.bookMeta)) {
    throw new Error('JSON file does not appear to be a KDP Studio project.');
  }
  return normalizeProject(data);
}

export function loadSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Ignore restricted storage
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore restricted storage
  }
}
