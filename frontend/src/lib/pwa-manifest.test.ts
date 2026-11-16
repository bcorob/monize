import { describe, it, expect } from 'vitest';
import { buildManifest } from './pwa-manifest';
import { THEME_SWATCHES } from './theme-swatches';
import {
  SHARE_STATEMENT_EXTENSIONS,
  SHARE_TARGET_ACCEPT,
  SHARE_TARGET_FILES_FIELD,
  SHARE_TARGET_PATH,
} from './share-target';
import { ACCEPTED_ATTACHMENT_TYPES } from '@/types/attachment';

describe('buildManifest', () => {
  it('serves the default light splash palette for a light resolved theme', () => {
    const manifest = buildManifest('light');
    expect(manifest.background_color).toBe(THEME_SWATCHES.default.light.page);
    expect(manifest.theme_color).toBe(THEME_SWATCHES.default.light.page);
  });

  it('serves the default dark splash palette for a dark resolved theme', () => {
    const manifest = buildManifest('dark');
    expect(manifest.background_color).toBe(THEME_SWATCHES.default.dark.page);
    expect(manifest.theme_color).toBe(THEME_SWATCHES.default.dark.page);
  });

  it('follows the active colour palette', () => {
    const nordDark = buildManifest('dark', 'nord');
    expect(nordDark.background_color).toBe(THEME_SWATCHES.nord.dark.page);

    const latteLight = buildManifest('light', 'latte');
    expect(latteLight.background_color).toBe(THEME_SWATCHES.latte.light.page);
  });

  it('falls back to the default light palette when no cookies exist', () => {
    const manifest = buildManifest(null, null);
    expect(manifest.background_color).toBe(THEME_SWATCHES.default.light.page);
    expect(manifest.theme_color).toBe(THEME_SWATCHES.default.light.page);
  });

  it('keeps the identity fields and icon set stable across themes', () => {
    const light = buildManifest('light');
    const dark = buildManifest('dark', 'midnight');

    expect(light.id).toBe('/');
    expect(light.name).toBe('Monize - Personal Finance Manager');
    expect(light.short_name).toBe('Monize');
    expect(light.start_url).toBe('/');
    expect(light.display).toBe('standalone');
    expect(light.icons).toHaveLength(4);
    expect(
      light.icons?.filter((icon) => icon.purpose === 'maskable'),
    ).toHaveLength(2);

    // Only the splash palette may differ between the two.
    expect({ ...dark, background_color: null, theme_color: null }).toEqual({
      ...light,
      background_color: null,
      theme_color: null,
    });
  });
});

describe('buildManifest share_target', () => {
  it('declares the file share target the worker answers', () => {
    const manifest = buildManifest('light');

    expect(manifest.share_target).toMatchObject({
      action: SHARE_TARGET_PATH,
      method: 'POST',
      enctype: 'multipart/form-data',
    });
    expect(manifest.share_target.params.files).toHaveLength(1);
    expect(manifest.share_target.params.files[0].name).toBe(
      SHARE_TARGET_FILES_FIELD,
    );
  });

  // The accept list is derived from what the server already accepts. Restating
  // it in the manifest is how a share sheet ends up offering a type the upload
  // then refuses, or hiding one it would have taken.
  it('accepts exactly the derived list, MIME types and extensions alike', () => {
    const accept = buildManifest('light').share_target.params.files[0].accept;

    expect(accept).toEqual([...SHARE_TARGET_ACCEPT]);
    for (const mime of ACCEPTED_ATTACHMENT_TYPES) {
      expect(accept).toContain(mime);
    }
    for (const extension of SHARE_STATEMENT_EXTENSIONS) {
      expect(accept).toContain(`.${extension}`);
    }
  });

  // Section 3.4 of the plan: declaring these would put Monize in the share
  // sheet for every piece of text on the device, with nowhere to put it.
  it('declares no text, title or url parameters', () => {
    const params = buildManifest('light').share_target.params as Record<
      string,
      unknown
    >;

    expect(Object.keys(params)).toEqual(['files']);
  });

  it('is the same on every theme, since the OS caches whichever it fetched', () => {
    expect(buildManifest('dark', 'midnight').share_target).toEqual(
      buildManifest('light').share_target,
    );
  });
});
