// ESA 环境适配：移除所有 Cloudflare Workflows、Queues、Durable Objects 的导出
// 仅保留 fetch 入口用于处理 HTTP 请求

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: {
        env: Env;
        executionCtx: ExecutionContext<unknown>;
      };
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const { handleRootRequest } = await import("@/lib/worker/root-handler");
    return handleRootRequest(request, env, ctx);
  },
  // queue 处理已移除，ESA 不提供队列服务
} satisfies ExportedHandler<Env>;
