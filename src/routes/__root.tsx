import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useRouteContext,
} from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { lazy, Suspense, type ComponentType } from "react";
import { ThemeProvider } from "@/components/common/theme-provider";
import { getFuwariThemeStyle } from "@/components/layout/document-style";
import { siteConfigQuery } from "@/features/config/queries";
import { getLocale } from "@/paraglide/runtime";
import appCss from "@/styles.css?url";

interface MyRouterContext {
  queryClient: QueryClient;
}

const loadDevtools = createIsomorphicFn()
  .client(() => import("@/integrations/tanstack-devtools"))
  .server(() =>
    Promise.resolve({
      default: function DevtoolsPlaceholder() {
        return null;
      },
    }),
  );

const AppDevtools = lazy(
  () => loadDevtools() as Promise<{ default: ComponentType }>,
);

export const Route = createRootRouteWithContext<MyRouterContext>()({
  beforeLoad: async ({ context }) => {
    const siteConfig =
      await context.queryClient.ensureQueryData(siteConfigQuery);
    return { siteConfig };
  },
  loader: async ({ context }) => {
    return {
      siteConfig: context.siteConfig,
      currentYear: new Date().getUTCFullYear(),
    };
  },
  head: ({ loaderData }) => {
    return {
      meta: [
        {
          charSet: "utf-8",
        },
        {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        },
        {
          title: loaderData?.siteConfig?.title,
        },
        {
          name: "description",
          content: loaderData?.siteConfig?.description,
        },
      ],
      links: [
        {
          rel: "icon",
          type: "image/svg+xml",
          href: loaderData?.siteConfig?.icons.faviconSvg,
        },
        {
          rel: "icon",
          type: "image/png",
          href: loaderData?.siteConfig?.icons.favicon96,
          sizes: "96x96",
        },
        {
          rel: "shortcut icon",
          href: loaderData?.siteConfig?.icons.faviconIco,
        },
        {
          rel: "apple-touch-icon",
          type: "image/png",
          href: loaderData?.siteConfig?.icons.appleTouchIcon,
          sizes: "180x180",
        },
        {
          rel: "manifest",
          href: "/site.webmanifest",
        },
        {
          rel: "stylesheet",
          href: appCss,
        },
        {
          rel: "alternate",
          type: "application/rss+xml",
          title: "RSS Feed",
          href: "/rss.xml",
        },
        {
          rel: "alternate",
          type: "application/atom+xml",
          title: "Atom Feed",
          href: "/atom.xml",
        },
        {
          rel: "alternate",
          type: "application/feed+json",
          title: "JSON Feed",
          href: "/feed.json",
        },
      ],
    };
  },
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const locale = getLocale();
  const { siteConfig } = useRouteContext({ from: "__root__" });

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      style={getFuwariThemeStyle(siteConfig)}
    >
      <head>
        <HeadContent />
        {/* 百度站长平台验证 */}
        <meta name="baidu-site-verification" content="codeva-Eq9IDPT82h" />
        {/* 解决 Cloudflare 禁用 referrer 的问题 */}
        <meta name="referrer" content="strict-origin-when-cross-origin" />
        {/* 百度统计 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              var _hmt = _hmt || [];
              (function() {
                var hm = document.createElement("script");
                hm.src = "https://hm.baidu.com/hm.js?e91606557ac83395f963cbc4e8a398ad";
                var s = document.getElementsByTagName("script")[0]; 
                s.parentNode.insertBefore(hm, s);
              })();
            `,
          }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <ClientOnly>
          <Suspense fallback={null}>
            <AppDevtools />
          </Suspense>
        </ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}
