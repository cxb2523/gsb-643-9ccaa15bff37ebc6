import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import request from 'supertest';
import app, { setServices, gitService, fileSystemService } from '../src/index';
import { FileSystemService } from '../src/services/fileSystem';
import { CacheService } from '../src/services/cache';
import { GitService } from '../src/services/gitService';

/**
 * Tests for the hardened renamePage / movePage operations.
 * Every test gets its own throwaway data directory under the OS temp folder:
 * no real user data and no network access are required.
 */

function cacheOf(service: FileSystemService): CacheService {
  return (service as unknown as { cache: CacheService }).cache;
}

async function makeService(): Promise<{
  service: FileSystemService;
  dataDir: string;
  cleanup: () => Promise<void>;
}> {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'codex-rename-move-'),
  );
  // No GitService: these tests target file-system + cache behaviour only.
  const service = new FileSystemService(dataDir, null);
  return {
    service,
    dataDir,
    cleanup: () => fs.rm(dataDir, { recursive: true, force: true }),
  };
}

async function writeFile(
  dataDir: string,
  relative: string,
  content: string,
): Promise<void> {
  const full = path.join(dataDir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

async function readFile(
  dataDir: string,
  relative: string,
): Promise<string> {
  return fs.readFile(path.join(dataDir, ...relative.split('/')), 'utf-8');
}

async function exists(dataDir: string, relative: string): Promise<boolean> {
  try {
    await fs.access(path.join(dataDir, ...relative.split('/')));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Recursive snapshot of the data directory (paths + contents) for diffing. */
async function snapshot(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childFull = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(`${childRel}/`);
        await walk(childFull, childRel);
      } else {
        out.push(`${childRel}:${await fs.readFile(childFull, 'utf-8')}`);
      }
    }
  }
  await walk(dataDir, '');
  return out;
}

describe('FileSystemService.renamePage hardening', () => {
  let dataDir: string;
  let service: FileSystemService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ service, dataDir, cleanup } = await makeService());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renames a page: new path holds the original content and old path is gone', async () => {
    await writeFile(dataDir, 'old-page.md', '# Original Content');

    await service.renamePage('old-page.md', 'new-page.md');

    await expect(readFile(dataDir, 'new-page.md')).resolves.toBe(
      '# Original Content',
    );
    await expect(readFile(dataDir, 'old-page.md')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(exists(dataDir, 'old-page.md')).resolves.toBe(false);
  });

  it('refuses to overwrite an existing target and leaves both files untouched', async () => {
    await writeFile(dataDir, 'a.md', 'SOURCE CONTENT');
    await writeFile(dataDir, 'b.md', 'TARGET CONTENT');

    // Prime caches so we can prove failure leaves no invalidation side effects.
    await service.getPages('');
    await service.getPageContent('a.md');
    await service.getPageContent('b.md');
    const cacheKeysBefore = cacheOf(service).getStats().keys.slice();

    await expect(
      service.renamePage('a.md', 'b.md'),
    ).rejects.toThrow(/already exists/);

    // Target content preserved, source still present.
    await expect(readFile(dataDir, 'b.md')).resolves.toBe('TARGET CONTENT');
    await expect(readFile(dataDir, 'a.md')).resolves.toBe('SOURCE CONTENT');

    // No cache entries were invalidated by the failed operation.
    expect(cacheOf(service).getStats().keys.sort()).toEqual(
      cacheKeysBefore.sort(),
    );
    await expect(service.getPageContent('b.md')).resolves.toBe(
      'TARGET CONTENT',
    );
  });

  it('treats source and target resolving to the same path as a successful no-op', async () => {
    await writeFile(dataDir, 'same.md', 'UNCHANGED');
    await service.getPages('');
    await service.getPageContent('same.md');
    const keysBefore = cacheOf(service).getStats().keys.slice();
    const treeBefore = await snapshot(dataDir);

    // Leading-slash variant resolves to the same absolute path.
    await expect(
      service.renamePage('same.md', '/same.md'),
    ).resolves.toBeUndefined();

    await expect(readFile(dataDir, 'same.md')).resolves.toBe('UNCHANGED');
    expect(await snapshot(dataDir)).toEqual(treeBefore);
    // No cache side effects from a no-op.
    expect(cacheOf(service).getStats().keys.sort()).toEqual(
      keysBefore.sort(),
    );
  });

  it('renames within the same folder without throwing and invalidates the relevant caches', async () => {
    await writeFile(dataDir, 'notes/draft.md', 'draft body');

    // Fill caches: folder listing and single-page content.
    const pagesBefore = await service.getPages('notes');
    expect(pagesBefore.map((p) => p.name)).toContain('draft.md');
    await service.getPageContent(path.join('notes', 'draft.md'));
    const cache = cacheOf(service);
    expect(
      cache.get(`pages:${path.join('notes')}`),
    ).not.toBeNull();

    await expect(
      service.renamePage(
        path.join('notes', 'draft.md'),
        path.join('notes', 'final.md'),
      ),
    ).resolves.toBeUndefined();

    // All affected keys (listing + both page keys) were invalidated.
    const keysAfter = cache.getStats().keys;
    expect(keysAfter).not.toContain(`pages:${path.join('notes')}`);
    expect(keysAfter).not.toContain(`page:${path.join('notes', 'draft.md')}`);
    expect(keysAfter).not.toContain(`page:${path.join('notes', 'final.md')}`);

    // Fresh reads reflect the new state.
    const pagesAfter = await service.getPages('notes');
    expect(pagesAfter.map((p) => p.name)).toContain('final.md');
    expect(pagesAfter.map((p) => p.name)).not.toContain('draft.md');
    await expect(
      service.getPageContent(path.join('notes', 'final.md')),
    ).resolves.toBe('draft body');
    await expect(
      service.getPageContent(path.join('notes', 'draft.md')),
    ).rejects.toThrow();
  });

  it('invalidates both source and target folder caches on a cross-folder rename', async () => {
    await writeFile(dataDir, 'dirA/page.md', 'cross content');
    await writeFile(dataDir, 'dirB/other.md', 'keep me');

    await service.getPages('dirA');
    await service.getPages('dirB');
    await service.getPageContent(path.join('dirA', 'page.md'));
    const cache = cacheOf(service);

    await service.renamePage(
      path.join('dirA', 'page.md'),
      path.join('dirB', 'page.md'),
    );

    const keys = cache.getStats().keys;
    expect(keys).not.toContain(`pages:${path.join('dirA')}`);
    expect(keys).not.toContain(`pages:${path.join('dirB')}`);
    expect(keys).not.toContain(`page:${path.join('dirA', 'page.md')}`);
    expect(keys).not.toContain(`page:${path.join('dirB', 'page.md')}`);

    await expect(exists(dataDir, path.join('dirA', 'page.md'))).resolves.toBe(
      false,
    );
    await expect(
      service.getPageContent(path.join('dirB', 'page.md')),
    ).resolves.toBe('cross content');
  });

  it('does not create destination directories when the source is missing', async () => {
    const treeBefore = await snapshot(dataDir);

    await expect(
      service.renamePage('missing.md', path.join('new-dir', 'gone.md')),
    ).rejects.toThrow(/does not exist/);

    // The old implementation created new-dir before failing; it must not exist.
    await expect(exists(dataDir, 'new-dir')).resolves.toBe(false);
    expect(await snapshot(dataDir)).toEqual(treeBefore);
  });

  it('rejects path traversal in either argument without touching the file system', async () => {
    await writeFile(dataDir, 'safe.md', 'inside');
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'codex-outside-'),
    );
    const sentinel = path.join(outsideDir, 'sentinel.md');
    await fs.writeFile(sentinel, 'do not touch');
    const treeBefore = await snapshot(dataDir);

    try {
      // Traversal via the source path.
      await expect(
        service.renamePage('../escape.md', 'whatever.md'),
      ).rejects.toThrow(/traversal/);
      // Traversal via the target path.
      await expect(
        service.renamePage('safe.md', '../escape-target.md'),
      ).rejects.toThrow(/traversal/);

      expect(await snapshot(dataDir)).toEqual(treeBefore);
      await expect(readFile(dataDir, 'safe.md')).resolves.toBe('inside');
      await expect(fs.readFile(sentinel, 'utf-8')).resolves.toBe(
        'do not touch',
      );
      await expect(exists(outsideDir, 'escape-target.md')).resolves.toBe(
        false,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('FileSystemService.movePage hardening', () => {
  let dataDir: string;
  let service: FileSystemService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ service, dataDir, cleanup } = await makeService());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('refreshes the root folder listing cache when renaming a root-level page', async () => {
    await writeFile(dataDir, 'root-old.md', 'root body');

    // Root listing is cached under the exact key "pages:" (never "pages:.").
    const rootPages = await service.getPages('');
    expect(rootPages.map((p) => p.name)).toContain('root-old.md');
    const cache = cacheOf(service);
    expect(cache.get('pages:')).not.toBeNull();

    await service.renamePage('root-old.md', 'root-new.md');

    // Root listing and both root-level page keys were invalidated.
    expect(cache.get('pages:')).toBeNull();
    expect(cache.getStats().keys).not.toContain('page:root-old.md');
    expect(cache.getStats().keys).not.toContain('page:root-new.md');

    const refreshed = await service.getPages('');
    expect(refreshed.map((p) => p.name)).toContain('root-new.md');
    expect(refreshed.map((p) => p.name)).not.toContain('root-old.md');
    await expect(service.getPageContent('root-new.md')).resolves.toBe(
      'root body',
    );
  });

  it('moves a page to another folder and refreshes all affected caches', async () => {
    await writeFile(dataDir, 'dirA/moving.md', 'MOVING BODY');
    await writeFile(dataDir, 'dirA/stay-a.md', 'stay in A');
    await writeFile(dataDir, 'dirB/stay-b.md', 'stay in B');

    // Prime every cache involved before the move.
    const listA = await service.getPages('dirA');
    const listB = await service.getPages('dirB');
    const contentA = await service.getPageContent(
      path.join('dirA', 'moving.md'),
    );
    expect(listA.map((p) => p.name)).toContain('moving.md');
    expect(listB.map((p) => p.name)).not.toContain('moving.md');
    expect(contentA).toBe('MOVING BODY');

    const newRelative = await service.movePage(
      path.join('dirA', 'moving.md'),
      'dirB',
    );
    expect(newRelative).toBe(path.join('dirB', 'moving.md'));

    // All four cache scopes (two folder lists, two page contents) were dropped.
    const keys = cacheOf(service).getStats().keys;
    expect(keys).not.toContain(`pages:${path.join('dirA')}`);
    expect(keys).not.toContain(`pages:${path.join('dirB')}`);
    expect(keys).not.toContain(`page:${path.join('dirA', 'moving.md')}`);
    expect(keys).not.toContain(`page:${path.join('dirB', 'moving.md')}`);

    // Re-read everything: both lists and both page states reflect the move.
    const listAAfter = await service.getPages('dirA');
    const listBAfter = await service.getPages('dirB');
    expect(listAAfter.map((p) => p.name)).toEqual(['stay-a.md']);
    expect(listBAfter.map((p) => p.name)).toEqual([
      'moving.md',
      'stay-b.md',
    ]);

    await expect(
      service.getPageContent(path.join('dirB', 'moving.md')),
    ).resolves.toBe('MOVING BODY');
    await expect(
      service.getPageContent(path.join('dirA', 'moving.md')),
    ).rejects.toThrow();
    await expect(
      exists(dataDir, path.join('dirA', 'moving.md')),
    ).resolves.toBe(false);
  });

  it('refreshes both root and subfolder listing caches when moving out of root', async () => {
    await writeFile(dataDir, 'loose.md', 'loose body');

    // Prime root listing ("pages:") and root page cache.
    expect((await service.getPages('')).map((p) => p.name)).toContain(
      'loose.md',
    );
    await service.getPageContent('loose.md');

    const result = await service.movePage('loose.md', 'nested');
    expect(result).toBe(path.join('nested', 'loose.md'));

    const cache = cacheOf(service);
    expect(cache.get('pages:')).toBeNull();
    expect(cache.getStats().keys).not.toContain(
      `pages:${path.join('nested')}`,
    );
    expect(cache.getStats().keys).not.toContain('page:loose.md');
    expect(cache.getStats().keys).not.toContain(
      `page:${path.join('nested', 'loose.md')}`,
    );

    const rootAfter = await service.getPages('');
    expect(rootAfter.map((p) => p.name)).not.toContain('loose.md');
    const nestedAfter = await service.getPages('nested');
    expect(nestedAfter.map((p) => p.name)).toContain('loose.md');
    await expect(
      service.getPageContent(path.join('nested', 'loose.md')),
    ).resolves.toBe('loose body');
  });

  it('refuses to move onto an existing file and preserves both files and caches', async () => {
    await writeFile(dataDir, 'src/page.md', 'SOURCE');
    await writeFile(dataDir, 'dest/page.md', 'DESTINATION');

    await service.getPages('src');
    await service.getPages('dest');
    await service.getPageContent(path.join('src', 'page.md'));
    await service.getPageContent(path.join('dest', 'page.md'));
    const keysBefore = cacheOf(service).getStats().keys.slice();

    await expect(
      service.movePage(path.join('src', 'page.md'), 'dest'),
    ).rejects.toThrow(/already exists/);

    await expect(readFile(dataDir, path.join('dest', 'page.md'))).resolves.toBe(
      'DESTINATION',
    );
    await expect(readFile(dataDir, path.join('src', 'page.md'))).resolves.toBe(
      'SOURCE',
    );
    expect(cacheOf(service).getStats().keys.sort()).toEqual(
      keysBefore.sort(),
    );
  });

  it('treats a same-folder move as a successful no-op without cache side effects', async () => {
    await writeFile(dataDir, 'folder/page.md', 'NO OP');
    await service.getPages('folder');
    await service.getPageContent(path.join('folder', 'page.md'));
    const keysBefore = cacheOf(service).getStats().keys.slice();
    const treeBefore = await snapshot(dataDir);

    const result = await service.movePage(
      path.join('folder', 'page.md'),
      'folder',
    );

    expect(result).toBe(path.join('folder', 'page.md'));
    expect(await snapshot(dataDir)).toEqual(treeBefore);
    expect(cacheOf(service).getStats().keys.sort()).toEqual(
      keysBefore.sort(),
    );
    await expect(
      service.getPageContent(path.join('folder', 'page.md')),
    ).resolves.toBe('NO OP');
  });

  it('does not create the destination folder when the source is missing', async () => {
    const treeBefore = await snapshot(dataDir);

    await expect(
      service.movePage('ghost.md', 'not-there'),
    ).rejects.toThrow(/does not exist/);

    await expect(exists(dataDir, 'not-there')).resolves.toBe(false);
    expect(await snapshot(dataDir)).toEqual(treeBefore);
  });

  it('rejects path traversal in the destination folder and changes nothing', async () => {
    await writeFile(dataDir, 'page.md', 'inside');
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'codex-outside-'),
    );
    const sentinel = path.join(outsideDir, 'sentinel.md');
    await fs.writeFile(sentinel, 'untouched');
    const treeBefore = await snapshot(dataDir);

    try {
      await expect(
        service.movePage('page.md', '../outside-temp'),
      ).rejects.toThrow(/traversal/);
      await expect(
        service.movePage('../page.md', 'dirB'),
      ).rejects.toThrow(/traversal/);

      expect(await snapshot(dataDir)).toEqual(treeBefore);
      await expect(readFile(dataDir, 'page.md')).resolves.toBe('inside');
      await expect(fs.readFile(sentinel, 'utf-8')).resolves.toBe('untouched');
      await expect(exists(outsideDir, 'page.md')).resolves.toBe(false);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('rename/move HTTP contract remains unchanged', () => {
  let dataDir: string;
  let httpService: FileSystemService;
  let cleanup: () => Promise<void>;
  const originalGit = gitService;
  const originalFs = fileSystemService;

  beforeAll(async () => {
    ({ service: httpService, dataDir, cleanup } = await makeService());
    setServices(null as unknown as GitService, httpService);
  });

  afterAll(async () => {
    setServices(originalGit, originalFs);
    await cleanup();
  });

  it('PUT /api/pages/rename/file keeps 200 and message/oldPath/newPath fields', async () => {
    await writeFile(dataDir, 'http-old.md', 'http body');

    const response = await request(app)
      .put('/api/pages/rename/file')
      .send({ oldPath: 'http-old.md', newPath: 'http-new.md' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'Page renamed successfully',
      oldPath: 'http-old.md',
      newPath: 'http-new.md',
    });
    await expect(readFile(dataDir, 'http-new.md')).resolves.toBe('http body');
  });

  it('PUT /api/pages/move keeps 200 and success/newPath fields', async () => {
    await writeFile(dataDir, 'src/http-page.md', 'move me');

    const response = await request(app)
      .put('/api/pages/move')
      .send({ oldPath: 'src/http-page.md', newFolderPath: 'dest' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.newPath).toBe(path.join('dest', 'http-page.md'));
  });

  it('returns 500 with error/message on a destination conflict', async () => {
    await writeFile(dataDir, 'conflict/a.md', 'A');
    await writeFile(dataDir, 'conflict/b.md', 'B');

    const response = await request(app)
      .put('/api/pages/rename/file')
      .send({ oldPath: 'conflict/a.md', newPath: 'conflict/b.md' });

    expect(response.status).toBe(500);
    expect(response.body).toHaveProperty('error');
    expect(response.body).toHaveProperty('message');
    expect(response.body.message).toMatch(/already exists/);
    await expect(
      readFile(dataDir, path.join('conflict', 'b.md')),
    ).resolves.toBe('B');
    await expect(
      readFile(dataDir, path.join('conflict', 'a.md')),
    ).resolves.toBe('A');
  });
});
