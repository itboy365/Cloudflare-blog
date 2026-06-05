import type { Env } from "@/lib/env/env";
import type { NotificationEvent } from "@/features/notification/notification.schema";
import { generateHtml, generateMessage, generateSubject, signPayload } from "@/features/webhook/webhook.helpers";

export async function sendWebhookRequest(
  ctx: { env: Env },
  params: { endpointId: string; url: string; secret: string; event: NotificationEvent },
  id: string,
  options?: { isTest?: boolean }
) {
  const payload = {
    id,
    type: params.event.type,
    timestamp: new Date().toISOString(),
    source: "flare-stack-blog",
    test: options?.isTest ?? false,
    data: params.event.data,
    subject: generateSubject(params.event),
    message: generateMessage(params.event),
    html: generateHtml(params.event),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "flare-stack-blog/webhook",
    "X-Flare-Event": params.event.type,
    "X-Flare-Timestamp": payload.timestamp,
  };

  if (params.secret) {
    headers["X-Flare-Signature"] = signPayload(payload, params.secret);
  }

  let body: string;
  if (params.url.includes("open.feishu.cn")) {
    // 飞书格式
    body = JSON.stringify({
      msg_type: "text",
      content: {
        text: payload.subject ? `${payload.subject}\n${payload.message}` : payload.message,
      },
    });
  } else {
    body = JSON.stringify(payload);
  }

  const response = await fetch(params.url, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Webhook 投递失败: ${response.status} ${errorText}`);
  }

  return response;
}
