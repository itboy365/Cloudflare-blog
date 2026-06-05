export async function sendWebhookRequest(
  ctx: { env: Env },
  params: { endpointId: string; url: string; secret: string; event: NotificationEvent },
  id: string,
  options?: { isTest?: boolean }
) {
  // ... 构造 payload
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

  // 可能还有签名生成
  let headers = {
    "Content-Type": "application/json",
    "X-Flare-Event": params.event.type,
    "X-Flare-Timestamp": payload.timestamp,
    // ... 签名头
  };

  let body = JSON.stringify(payload);

  // 在这里添加飞书适配
  if (params.url.includes("open.feishu.cn")) {
    // 转换成飞书格式
    const feishuBody = {
      msg_type: "text",
      content: {
        text: payload.message, // 或者拼接更丰富的内容，如 `[${payload.subject}] ${payload.message}`
      },
    };
    body = JSON.stringify(feishuBody);
    // 可选：飞书不需要自定义头，但保留无害；如果你想精简也可以移除 signature 等
  }

  const response = await fetch(params.url, { method: "POST", headers, body });
  // ... 处理响应
}
