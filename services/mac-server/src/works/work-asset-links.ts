import fs from 'node:fs';
import type {
  AssetRecord,
  AttachWorkMediaResponse,
  LinkWorkAssetRequest,
  ReorderWorkAssetsRequest,
  WorkAssetItem,
  WorkAssetRole,
  WorkDetail,
} from '@qiu-creator/contracts';
import { parseWorkSource, writeWorkSource, type WorkSourceChange } from '@qiu-creator/domain';
import type { AssetService } from '../assets/asset-service.js';
import type { Principal } from '../auth/token-service.js';
import { notFound, ServiceError } from '../errors.js';
import type { WorkMediaAttacher } from '../media/attach.js';
import { isTypedWork } from './typed-media.js';
import type { WorkComposer } from './work-composer.js';
import type { TypedWorkState, WorkService } from './work-service.js';

type TypedType = 'image' | 'video';

/** The link roles an image or video work can show, and the kind of file each takes. */
const TYPED_ROLES: Record<TypedType, Partial<Record<WorkAssetRole, 'image' | 'video'>>> = {
  image: { body: 'image', cover: 'image' },
  video: { video: 'video', cover: 'image' },
};

/** The front-matter field behind a role, as `PATCH /works/:id` names it in events. */
const ROLE_FIELDS: Record<WorkAssetRole, string> = {
  body: 'images',
  cover: 'cover',
  video: 'video_asset_id',
};

/**
 * Putting assets on a work (QC-102). Image and video works show exactly the
 * files their front matter names, so for them every link, unlink, reorder,
 * attach and URL import writes the front matter as a new revision (restorable,
 * attributed to the agent that asked) and then records the link. The change is
 * applied to the latest revision without awaiting in between, so it never
 * replaces anyone's edit. Articles keep their links apart from the text, which
 * is never written here.
 */
export class WorkAssetLinks {
  constructor(
    private readonly works: WorkService,
    private readonly assets: AssetService,
    private readonly composer: WorkComposer,
    private readonly attacher: WorkMediaAttacher,
  ) {}

  /** `POST /works/:id/assets`. */
  async link(workId: string, input: LinkWorkAssetRequest): Promise<WorkAssetItem[]> {
    const { asset_id: assetId, role, position } = input;
    const work = this.works.get(workId); // 404 for an unknown work
    if (!isTypedWork(work.type)) return this.assets.link(workId, assetId, role, position);
    await this.place(work, work.type, assetId, role, position);
    return this.assets.workAssets(workId);
  }

  /** `DELETE /works/:id/assets/:assetId?role=`. */
  unlink(workId: string, assetId: string, role: WorkAssetRole): WorkAssetItem[] {
    const work = this.works.get(workId);
    if (!isTypedWork(work.type)) return this.assets.unlink(workId, assetId, role);

    const change: WorkSourceChange = {};
    const media = work.media;
    if (role === 'body') {
      const images = media?.images ?? [];
      const kept = images.filter((i) => i.asset_id !== assetId);
      if (kept.length < images.length) {
        change.images = kept.map((i) => i.path);
        // As in the editor: a cover that left the post falls back to the first image.
        const cover = media?.cover?.kind === 'image' ? media.cover.item.path : null;
        if (
          cover !== null &&
          !change.images.includes(cover) &&
          images.some((i) => i.path === cover)
        )
          change.cover = null;
      }
    } else if (role === 'cover') {
      if (media?.cover?.kind === 'image' && media.cover.item.asset_id === assetId)
        change.cover = null;
    } else if (media?.video?.asset_id === assetId) {
      change.video = null;
    }

    const shown = Object.keys(change).length > 0;
    const linked = this.assets.hasLink(workId, assetId, role);
    if (!shown && !linked) throw notFound('work asset link');
    if (shown) this.commit(this.stateOf(work), change, [ROLE_FIELDS[role]], {});
    if (linked) this.assets.unlink(workId, assetId, role);
    if (change.cover === null && role === 'body' && this.assets.hasLink(workId, assetId, 'cover'))
      this.assets.unlink(workId, assetId, 'cover');
    return this.assets.workAssets(workId);
  }

  /** `PUT /works/:id/assets/order`. */
  reorder(workId: string, input: ReorderWorkAssetsRequest): WorkAssetItem[] {
    const { role, asset_ids: wanted } = input;
    const work = this.works.get(workId);
    if (!isTypedWork(work.type)) return this.assets.reorder(workId, role, wanted);
    requireRole(work.type, role);

    const state = this.stateOf(work);
    requireReadable(state);
    const media = work.media;
    const images = media?.images ?? [];
    const cover = media?.cover?.kind === 'image' ? media.cover.item.asset_id : null;
    const current =
      role === 'body'
        ? unique(images.map((i) => i.asset_id))
        : unique([role === 'cover' ? cover : (media?.video?.asset_id ?? null)]);
    const same =
      current.length === wanted.length &&
      new Set(wanted).size === wanted.length &&
      wanted.every((id) => current.includes(id));
    if (!same) {
      throw new ServiceError(
        400,
        'validation_error',
        'asset_ids must list every asset the work shows in this role exactly once',
        { current },
      );
    }
    if (role === 'body') {
      // Files without a library asset keep their place; the others fill the remaining places.
      const queue = [...wanted];
      const moved = new Set<string>();
      const paths = images.map((item) => {
        if (item.asset_id === null || moved.has(item.asset_id)) return item.path;
        moved.add(item.asset_id);
        const next = queue.shift();
        return images.find((i) => i.asset_id === next)?.path ?? item.path;
      });
      if (
        !samePaths(
          paths,
          images.map((i) => i.path),
        )
      ) {
        this.commit(state, { images: paths }, [ROLE_FIELDS[role]], {});
      }
    }
    this.assets.syncRole(workId, role, wanted, { single: role !== 'body', change: 'reordered' });
    return this.assets.workAssets(workId);
  }

  /**
   * `POST /works/:id/media/attach`. For an image or video work the file also
   * goes on the work: an image into an image post, a video as the video.
   */
  async attach(workId: string, assetId: string): Promise<AttachWorkMediaResponse> {
    const work = this.works.get(workId);
    // External works answer 409 there, whatever their type.
    if (!isTypedWork(work.type) || work.storage_mode === 'external') {
      return this.attacher.attach(workId, assetId);
    }
    const role = this.assets.get(assetId).kind === 'video' ? 'video' : 'body';
    const placed = await this.place(work, work.type, assetId, role, undefined);
    return { src: placed.path, copied: placed.copied, asset: this.assets.get(assetId) };
  }

  /** Checks made when a URL import naming a work is queued. */
  checkImport(principal: Principal, workId: string, role: WorkAssetRole | undefined): void {
    const type = this.works.get(workId).type;
    if (!isTypedWork(type)) return;
    requireWrite(principal);
    if (role !== undefined) requireRole(type, role);
  }

  /** The token that queued an import is gone: it may not change an image or video work. */
  refuseRevoked(workId: string): void {
    if (isTypedWork(this.works.get(workId).type)) {
      throw new ServiceError(403, 'forbidden', 'the token that started this import is revoked');
    }
  }

  /**
   * Put a downloaded asset on the work of its import. Without a role, a video
   * is the video; an image joins an image post, or becomes the cover of a video
   * work that has none (it never replaces a cover unasked).
   */
  async linkImported(
    principal: Principal | null,
    workId: string,
    asset: AssetRecord,
    role: WorkAssetRole | undefined,
  ): Promise<void> {
    const work = this.works.get(workId);
    let wanted: WorkAssetRole = role ?? (asset.kind === 'video' ? 'video' : 'body');
    if (!isTypedWork(work.type)) {
      this.assets.link(workId, asset.id, wanted);
      return;
    }
    if (principal !== null) requireWrite(principal);
    if (role === undefined && work.type === 'video' && asset.kind === 'image') {
      const cover = work.media?.cover ?? null;
      if (cover !== null && !(cover.kind === 'image' && cover.item.asset_id === asset.id)) {
        throw new ServiceError(
          400,
          'validation_error',
          'the image is in the library, but this video work already has a cover; link it with role "cover" to replace it',
          { asset_id: asset.id },
        );
      }
      wanted = 'cover';
    }
    await this.place(work, work.type, asset.id, wanted, undefined);
  }

  /** Copy the asset's file into the work if needed and write it into the front matter. */
  private async place(
    work: WorkDetail,
    type: TypedType,
    assetId: string,
    role: WorkAssetRole,
    position: number | undefined,
  ): Promise<{ path: string; copied: boolean }> {
    const kind = requireRole(type, role);
    const before = this.stateOf(work);
    requireReadable(before);
    const copied: string[] = [];
    const mediaIndex: Record<string, string> = {};
    try {
      const file = await this.composer.resolveFile(before, assetId, kind, copied, mediaIndex, {
        link: false,
      });
      // Copying took a while: apply the change to the work as it is now.
      const latest = this.works.get(work.id);
      const state = this.stateOf(latest);
      requireReadable(state);
      const front = parseWorkSource(state.markdown).frontMatter;
      const media = latest.media;
      const change: WorkSourceChange = {};
      let linked = [assetId];
      if (role === 'body') {
        const images = media?.images ?? [];
        const others = images.filter((i) => i.path !== file && i.asset_id !== assetId);
        const at = position === undefined ? others.length : Math.min(position, others.length);
        const next = others.map((i) => ({ path: i.path, asset_id: i.asset_id }));
        next.splice(at, 0, { path: file, asset_id: assetId });
        const paths = next.map((i) => i.path);
        if (!samePaths(paths, front?.images ?? [])) change.images = paths;
        linked = unique(next.map((i) => i.asset_id));
      } else if (role === 'cover') {
        const cover = front?.cover ?? null;
        if (cover === null || !('path' in cover) || cover.path !== file)
          change.cover = { path: file };
      } else if (front?.video !== file) {
        change.video = file;
      }
      if (Object.keys(change).length > 0) {
        this.commit(state, change, [ROLE_FIELDS[role]], mediaIndex);
      }
      this.assets.syncRole(work.id, role, linked, {
        single: role !== 'body',
        assetId,
        change: 'linked',
      });
      return { path: file, copied: copied.length > 0 };
    } catch (err) {
      // Nothing saved refers to a file copied for this request.
      for (const created of copied) fs.rmSync(created, { force: true });
      throw err;
    }
  }

  private stateOf(work: WorkDetail): TypedWorkState {
    return this.works.typedState(work.id, work.current_revision_id);
  }

  private commit(
    state: TypedWorkState,
    change: WorkSourceChange,
    fields: string[],
    mediaIndex: Record<string, string>,
  ): void {
    requireReadable(state);
    const front = parseWorkSource(state.markdown).frontMatter;
    const markdown = writeWorkSource(state.markdown, {
      ...(front?.type === state.type ? {} : { type: state.type }),
      ...change,
    });
    this.works.commitTyped(state.location.id, state.currentRevision, {
      markdown,
      title: undefined,
      type: undefined,
      status: undefined,
      tags: undefined,
      aiJobId: undefined,
      fields,
      mediaIndex,
    });
  }
}

function requireRole(type: TypedType, role: WorkAssetRole): 'image' | 'video' {
  const kind = TYPED_ROLES[type][role];
  if (kind !== undefined) return kind;
  throw new ServiceError(
    400,
    'validation_error',
    type === 'image'
      ? 'an image work takes role "body" (its images) or "cover"'
      : 'a video work takes role "video" or "cover" (an image)',
    { work_type: type, role, allowed: Object.keys(TYPED_ROLES[type]) },
  );
}

/** Changing an image or video work rewrites its front matter: more than linking. */
function requireWrite(principal: Principal): void {
  if (principal.scopes.includes('write')) return;
  throw new ServiceError(
    403,
    'forbidden',
    'putting a file on an image or video work changes it; this token lacks the "write" permission',
    { required: 'write' },
  );
}

function requireReadable(state: TypedWorkState): void {
  if (parseWorkSource(state.markdown).invalid) {
    throw new ServiceError(
      409,
      'front_matter_invalid',
      'the front matter of this work is not valid YAML; fix it in the file first',
    );
  }
}

function unique(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}
