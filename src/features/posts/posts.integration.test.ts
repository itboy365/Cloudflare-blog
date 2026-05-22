import { z } from "zod";
import * as AiService from "@/features/ai/ai.service";
import * as CacheService from "@/features/cache/cache.service";
import { syncPostMedia } from "@/features/posts/data/post-media.data";
import * as PostRevisionRepo from "@/features/posts/data/post-revisions.data";
import * as PostRepo from "@/features/posts/data/posts.data";
import type {
  DeletePostInput,
  FindPostByIdInput,
  FindPostBySlugInput,
  FindRelatedPostsInput,
  GenerateSlugInput,
  GetPostsCountInput,
  GetPostsCursorInput,
  GetPostsInput,
  PreviewSummaryInput,
  StartPostProcessInput,
  UpdatePostInput,
} from "@/features/posts/schema/posts.schema";
import {
  POSTS_CACHE_KEYS,
  PostItemSchema,
  PostListResponseSchema,
  PostWithTocSchema,
} from "@/features/posts/schema/posts.schema";
// import { logPostAutoSnapshot } from "@/features/posts/services/post-auto-snapshot.logging";
// import * as PostAutoSnapshotService from "@/features/posts/services/post-auto-snapshot.service";
import {
  convertToPlainText,
  highlightCodeBlocks,
  slugify,
} from "@/features/posts/utils/content";
import { isFuturePublishDate } from "@/features/posts/utils/date";
import { calculatePostHash } from "@/features/posts/utils/sync";
import { generateTableOfContents } from "@/features/posts/utils/toc";
import * as SearchService from "@/features/search/service/search.service";
import { err, ok } from "@/lib/errors";
import { purgePostCDNCache } from "@/lib/invalidate";

function stripPublicContentJson<T extends { publicContentJson?: unknown }>(
  post: T,
): Omit<T, "publicContentJson"> {
  const { publicContentJson: _publicContentJson, ...rest } = post;
  return rest;
}

export async function getPinnedPosts(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  const version = await CacheService.getVersion(context, "posts:list");
  return CacheService.get(
    context,
    POSTS_CACHE_KEYS.pinned(version),
    PostItemSchema.array(),
    () => PostRepo.findPinnedPosts(context.db),
    { ttl: "7d" },
  );
}

export async function getPostsCursor(
  context: DbContext & { executionCtx: ExecutionContext },
  data: GetPostsCursorInput,
) {
  const fetcher = async () =>
    await PostRepo.getPostsCursor(context.db, {
      cursor: data.cursor,
      limit: data.limit,
      publicOnly: true,
      tagName: data.tagName,
      excludePinned: data.excludePinned,
    });

  const version = await CacheService.getVersion(context, "posts:list");
  const cacheKey = POSTS_CACHE_KEYS.list(
    version,
    data.limit ?? 10,
    data.cursor ?? 0,
    data.tagName ?? "all",
  );

  return await CacheService.get(
    context,
    cacheKey,
    PostListResponseSchema,
    fetcher,
    {
      ttl: "7d",
    },
  );
}

export async function findPostBySlug(
  context: DbContext & { executionCtx: ExecutionContext },
  data: FindPostBySlugInput,
) {
  const fetcher = async () => {
    const post = await PostRepo.findPostBySlug(context.db, data.slug, {
      publicOnly: true,
    });
    if (!post) return null;

    let contentJson = post.publicContentJson ?? post.contentJson;
    if (!post.publicContentJson && contentJson) {
      contentJson = await highlightCodeBlocks(contentJson);
      context.executionCtx.waitUntil(
        PostRepo.updatePublicContentSnapshot(
          context.db,
          post.id,
          contentJson,
        ).then(() => undefined),
      );
    }

    return {
      ...stripPublicContentJson(post),
      contentJson,
      toc: generateTableOfContents(contentJson),
    };
  };

  const version = await CacheService.getVersion(context, "posts:detail");
  const cacheKey = POSTS_CACHE_KEYS.detail(version, data.slug);
  return await CacheService.get(context, cacheKey, PostWithTocSchema, fetcher, {
    ttl: "7d",
  });
}

export async function getRelatedPosts(
  context: DbContext & { executionCtx: ExecutionContext },
  data: FindRelatedPostsInput,
) {
  const fetcher = async () => {
    const postIds = await PostRepo.getRelatedPostIds(context.db, data.slug, {
      limit: data.limit,
    });
    return postIds;
  };

  const cacheKey = POSTS_CACHE_KEYS.related(data.slug, data.limit);
  const cachedIds = await CacheService.get(
    context,
    cacheKey,
    z.array(z.number()),
    fetcher,
    {
      ttl: "7d",
    },
  );

  if (cachedIds.length === 0) {
    return [];
  }

  const posts = await PostRepo.getPublicPostsByIds(context.db, cachedIds);
  const orderedPosts = cachedIds
    .map((id) => posts.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p);

  return orderedPosts;
}

export async function generateSummaryByPostId({
  context,
  postId,
}: {
  context: DbContext;
  postId: number;
}) {
  const post = await PostRepo.findPostById(context.db, postId);

  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  if (post.summary && post.summary.trim().length > 0) return ok(post);

  const plainText = convertToPlainText(post.contentJson);
  if (plainText.length < 100) {
    return ok(post);
  }

  const { summary } = await AiService.summarizeText(context, plainText);

  const updatedPost = await PostRepo.updatePost(context.db, post.id, {
    summary,
  });

  if (!updatedPost) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  return ok(stripPublicContentJson(updatedPost));
}

// ============ Admin Service Methods ============

export async function generateSlug(
  context: DbContext,
  data: GenerateSlugInput,
) {
  const baseSlug = slugify(data.title);
  const exactMatch = await PostRepo.slugExists(context.db, baseSlug, {
    excludeId: data.excludeId,
  });
  if (!exactMatch) {
    return { slug: baseSlug };
  }

  const similarSlugs = await PostRepo.findSimilarSlugs(context.db, baseSlug, {
    excludeId: data.excludeId,
  });

  const regex = new RegExp(`^${baseSlug}-(\\d+)$`);
  let maxSuffix = 0;
  for (const slug of similarSlugs) {
    const match = slug.match(regex);
    if (match) {
      const number = parseInt(match[1], 10);
      if (number > maxSuffix) {
        maxSuffix = number;
      }
    }
  }

  return { slug: `${baseSlug}-${maxSuffix + 1}` };
}

export async function createEmptyPost(context: DbContext) {
  const { slug } = await generateSlug(context, { title: "" });

  const post = await PostRepo.insertPost(context.db, {
    title: "",
    slug,
    summary: "",
    status: "draft",
    readTimeInMinutes: 1,
    contentJson: null,
  });

  return { id: post.id };
}

export async function getPosts(context: DbContext, data: GetPostsInput) {
  return await PostRepo.getPosts(context.db, {
    offset: data.offset ?? 0,
    limit: data.limit ?? 10,
    status: data.status,
    publicOnly: data.publicOnly,
    search: data.search,
    sortDir: data.sortDir,
    sortBy: data.sortBy,
  });
}

export async function getPostsCount(
  context: DbContext,
  data: GetPostsCountInput,
) {
  return await PostRepo.getPostsCount(context.db, {
    status: data.status,
    publicOnly: data.publicOnly,
    search: data.search,
  });
}

export async function findPostBySlugAdmin(
  context: DbContext,
  data: FindPostBySlugInput,
) {
  const post = await PostRepo.findPostBySlug(context.db, data.slug, {
    publicOnly: false,
  });
  if (!post) return null;
  return {
    ...stripPublicContentJson(post),
    toc: generateTableOfContents(post.contentJson),
  };
}

export async function findPostById(
  context: DbContext,
  data: FindPostByIdInput,
) {
  const post = await PostRepo.findPostById(context.db, data.id);
  if (!post) return null;

  const kvHash = await CacheService.getRaw(
    context,
    POSTS_CACHE_KEYS.syncHash(post.id),
  );
  const hasPublicCache = kvHash !== null;

  let isSynced: boolean;
  if (post.status === "draft") {
    isSynced = !hasPublicCache;
  } else {
    const dbHash = await calculatePostHash({
      title: post.title,
      contentJson: post.contentJson,
      summary: post.summary,
      tagIds: post.tags.map((t) => t.id),
      slug: post.slug,
      publishedAt: post.publishedAt,
      pinnedAt: post.pinnedAt,
      readTimeInMinutes: post.readTimeInMinutes,
    });
    isSynced = dbHash === kvHash;
  }

  return { ...stripPublicContentJson(post), isSynced, hasPublicCache };
}

export async function updatePost(
  context: DbContext & { executionCtx: ExecutionContext; env?: Env },
  data: UpdatePostInput,
) {
  const updatedPost = await PostRepo.updatePost(context.db, data.id, data.data);
  if (!updatedPost) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  if (data.data.contentJson !== undefined) {
    context.executionCtx.waitUntil(
      syncPostMedia(context.db, updatedPost.id, data.data.contentJson),
    );
  }

  // 自动快照功能已在 ESA 迁移中移除
  // context.executionCtx.waitUntil(
  //   PostAutoSnapshotService.enqueuePostAutoSnapshot(context, {
  //     postId: updatedPost.id,
  //     source: "post_update",
  //   }),
  // );

  return ok(updatedPost);
}

export async function deletePost(
  context: DbContext & { executionCtx: ExecutionContext },
  data: DeletePostInput,
) {
  const post = await PostRepo.findPostById(context.db, data.id);
  if (!post) {
    return err({ reason: "POST_NOT_FOUND" });
  }

  await PostRepo.deletePost(context.db, data.id);

  if (post.status === "published") {
    const tasks = [];
    const version = await CacheService.getVersion(context, "posts:detail");
    tasks.push(
      CacheService.deleteKey(
        context,
        POSTS_CACHE_KEYS.detail(version, post.slug),
      ),
    );
    tasks.push(CacheService.bumpVersion(context, "posts:list"));
    tasks.push(SearchService.deleteIndex(context, { id: data.id }));
    tasks.push(purgePostCDNCache(context.env, post.slug));
    tasks.push(
      CacheService.deleteKey(context, POSTS_CACHE_KEYS.syncHash(data.id)),
    );

    context.executionCtx.waitUntil(Promise.all(tasks));
  } else {
    context.executionCtx.waitUntil(
      CacheService.deleteKey(context, POSTS_CACHE_KEYS.syncHash(data.id)),
    );
  }

  return ok({ success: true });
}

export async function previewSummary(
  context: DbContext,
  data: PreviewSummaryInput,
) {
  const plainText = convertToPlainText(data.contentJson);
  const { summary } = await AiService.summarizeText(context, plainText);
  return { summary };
}

// 重构后的 startPostProcessWorkflow，移除所有 Cloudflare Workflows 依赖
export async function startPostProcessWorkflow(
  context: DbContext & { env?: Env },
  data: StartPostProcessInput,
) {
  // 仅处理发布时间设置，不再创建任何 Cloudflare Workflows
  if (data.status === "published") {
    const post = await PostRepo.findPostById(context.db, data.id);
    if (post && !post.publishedAt) {
      const now = new Date();
      await PostRepo.updatePost(context.db, post.id, {
        publishedAt: now,
      });
    }
  }
  // 所有与 Cloudflare 强绑定的 workflow 调用均已移除
}
