// vite.config.ts
import path from "node:path";
import { defineConfig } from "file:///Users/calum.macrae/source/swarmy/node_modules/.bun/vite@5.4.21+859f710caf2c49ef/node_modules/vite/dist/node/index.js";
import react from "file:///Users/calum.macrae/source/swarmy/node_modules/.bun/@vitejs+plugin-react@4.7.0+d448faf24211f412/node_modules/@vitejs/plugin-react/dist/index.js";
import { TanStackRouterVite } from "file:///Users/calum.macrae/source/swarmy/node_modules/.bun/@tanstack+router-plugin@1.168.18+e3023b1b765c233b/node_modules/@tanstack/router-plugin/dist/esm/vite.js";
import tailwindcss from "file:///Users/calum.macrae/source/swarmy/node_modules/.bun/@tailwindcss+vite@4.3.1+d448faf24211f412/node_modules/@tailwindcss/vite/dist/index.mjs";
var __vite_injected_original_dirname = "/Users/calum.macrae/source/swarmy/apps/app";
var pkg = (p) => path.resolve(__vite_injected_original_dirname, "../../packages", p);
var vite_config_default = defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__vite_injected_original_dirname, "./src") },
      { find: "@swarmy/ui/styles.css", replacement: pkg("ui/src/styles.css") },
      { find: /^@swarmy\/ui$/, replacement: pkg("ui/src/index.ts") },
      { find: /^@swarmy\/ui\/(.*)$/, replacement: pkg("ui/src/$1") },
      { find: /^@swarmy\/core$/, replacement: pkg("core/src/index.ts") },
      { find: /^@swarmy\/core\/(.*)$/, replacement: pkg("core/src/$1") },
      { find: /^@swarmy\/auth\/client$/, replacement: pkg("auth/src/client.ts") }
    ]
  },
  server: {
    port: 3023,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:3021", changeOrigin: true },
      "/install.sh": { target: "http://localhost:3021", changeOrigin: true },
      "/agent": { target: "ws://localhost:3021", ws: true },
      // Browser terminal data plane (xterm → controller `/term/ws`). Same-origin
      // in prod; in dev the page is served from :3023, so proxy the WS upgrade to
      // the controller at :3021 (mirrors `/agent`). Without this the socket hits
      // the Vite dev origin and never reaches the API, so the shell never attaches.
      "/term": { target: "ws://localhost:3021", ws: true }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvY2FsdW0ubWFjcmFlL3NvdXJjZS9zd2FybXkvYXBwcy9hcHBcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9jYWx1bS5tYWNyYWUvc291cmNlL3N3YXJteS9hcHBzL2FwcC92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvY2FsdW0ubWFjcmFlL3NvdXJjZS9zd2FybXkvYXBwcy9hcHAvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgcGF0aCBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuaW1wb3J0IHsgVGFuU3RhY2tSb3V0ZXJWaXRlIH0gZnJvbSAnQHRhbnN0YWNrL3JvdXRlci1wbHVnaW4vdml0ZSc7XG5pbXBvcnQgdGFpbHdpbmRjc3MgZnJvbSAnQHRhaWx3aW5kY3NzL3ZpdGUnO1xuXG5jb25zdCBwa2cgPSAocDogc3RyaW5nKSA9PiBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCAnLi4vLi4vcGFja2FnZXMnLCBwKTtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgcGx1Z2luczogW1xuICAgIFRhblN0YWNrUm91dGVyVml0ZSh7IHRhcmdldDogJ3JlYWN0JywgYXV0b0NvZGVTcGxpdHRpbmc6IHRydWUgfSksXG4gICAgcmVhY3QoKSxcbiAgICB0YWlsd2luZGNzcygpLFxuICBdLFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IFtcbiAgICAgIHsgZmluZDogJ0AnLCByZXBsYWNlbWVudDogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4vc3JjJykgfSxcbiAgICAgIHsgZmluZDogJ0Bzd2FybXkvdWkvc3R5bGVzLmNzcycsIHJlcGxhY2VtZW50OiBwa2coJ3VpL3NyYy9zdHlsZXMuY3NzJykgfSxcbiAgICAgIHsgZmluZDogL15Ac3dhcm15XFwvdWkkLywgcmVwbGFjZW1lbnQ6IHBrZygndWkvc3JjL2luZGV4LnRzJykgfSxcbiAgICAgIHsgZmluZDogL15Ac3dhcm15XFwvdWlcXC8oLiopJC8sIHJlcGxhY2VtZW50OiBwa2coJ3VpL3NyYy8kMScpIH0sXG4gICAgICB7IGZpbmQ6IC9eQHN3YXJteVxcL2NvcmUkLywgcmVwbGFjZW1lbnQ6IHBrZygnY29yZS9zcmMvaW5kZXgudHMnKSB9LFxuICAgICAgeyBmaW5kOiAvXkBzd2FybXlcXC9jb3JlXFwvKC4qKSQvLCByZXBsYWNlbWVudDogcGtnKCdjb3JlL3NyYy8kMScpIH0sXG4gICAgICB7IGZpbmQ6IC9eQHN3YXJteVxcL2F1dGhcXC9jbGllbnQkLywgcmVwbGFjZW1lbnQ6IHBrZygnYXV0aC9zcmMvY2xpZW50LnRzJykgfSxcbiAgICBdLFxuICB9LFxuICBzZXJ2ZXI6IHtcbiAgICBwb3J0OiAzMDIzLFxuICAgIHN0cmljdFBvcnQ6IHRydWUsXG4gICAgcHJveHk6IHtcbiAgICAgICcvYXBpJzogeyB0YXJnZXQ6ICdodHRwOi8vbG9jYWxob3N0OjMwMjEnLCBjaGFuZ2VPcmlnaW46IHRydWUgfSxcbiAgICAgICcvaW5zdGFsbC5zaCc6IHsgdGFyZ2V0OiAnaHR0cDovL2xvY2FsaG9zdDozMDIxJywgY2hhbmdlT3JpZ2luOiB0cnVlIH0sXG4gICAgICAnL2FnZW50JzogeyB0YXJnZXQ6ICd3czovL2xvY2FsaG9zdDozMDIxJywgd3M6IHRydWUgfSxcbiAgICAgIC8vIEJyb3dzZXIgdGVybWluYWwgZGF0YSBwbGFuZSAoeHRlcm0gXHUyMTkyIGNvbnRyb2xsZXIgYC90ZXJtL3dzYCkuIFNhbWUtb3JpZ2luXG4gICAgICAvLyBpbiBwcm9kOyBpbiBkZXYgdGhlIHBhZ2UgaXMgc2VydmVkIGZyb20gOjMwMjMsIHNvIHByb3h5IHRoZSBXUyB1cGdyYWRlIHRvXG4gICAgICAvLyB0aGUgY29udHJvbGxlciBhdCA6MzAyMSAobWlycm9ycyBgL2FnZW50YCkuIFdpdGhvdXQgdGhpcyB0aGUgc29ja2V0IGhpdHNcbiAgICAgIC8vIHRoZSBWaXRlIGRldiBvcmlnaW4gYW5kIG5ldmVyIHJlYWNoZXMgdGhlIEFQSSwgc28gdGhlIHNoZWxsIG5ldmVyIGF0dGFjaGVzLlxuICAgICAgJy90ZXJtJzogeyB0YXJnZXQ6ICd3czovL2xvY2FsaG9zdDozMDIxJywgd3M6IHRydWUgfSxcbiAgICB9LFxuICB9LFxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWdULE9BQU8sVUFBVTtBQUNqVSxTQUFTLG9CQUFvQjtBQUM3QixPQUFPLFdBQVc7QUFDbEIsU0FBUywwQkFBMEI7QUFDbkMsT0FBTyxpQkFBaUI7QUFKeEIsSUFBTSxtQ0FBbUM7QUFNekMsSUFBTSxNQUFNLENBQUMsTUFBYyxLQUFLLFFBQVEsa0NBQVcsa0JBQWtCLENBQUM7QUFFdEUsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsU0FBUztBQUFBLElBQ1AsbUJBQW1CLEVBQUUsUUFBUSxTQUFTLG1CQUFtQixLQUFLLENBQUM7QUFBQSxJQUMvRCxNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsRUFDZDtBQUFBLEVBQ0EsU0FBUztBQUFBLElBQ1AsT0FBTztBQUFBLE1BQ0wsRUFBRSxNQUFNLEtBQUssYUFBYSxLQUFLLFFBQVEsa0NBQVcsT0FBTyxFQUFFO0FBQUEsTUFDM0QsRUFBRSxNQUFNLHlCQUF5QixhQUFhLElBQUksbUJBQW1CLEVBQUU7QUFBQSxNQUN2RSxFQUFFLE1BQU0saUJBQWlCLGFBQWEsSUFBSSxpQkFBaUIsRUFBRTtBQUFBLE1BQzdELEVBQUUsTUFBTSx1QkFBdUIsYUFBYSxJQUFJLFdBQVcsRUFBRTtBQUFBLE1BQzdELEVBQUUsTUFBTSxtQkFBbUIsYUFBYSxJQUFJLG1CQUFtQixFQUFFO0FBQUEsTUFDakUsRUFBRSxNQUFNLHlCQUF5QixhQUFhLElBQUksYUFBYSxFQUFFO0FBQUEsTUFDakUsRUFBRSxNQUFNLDJCQUEyQixhQUFhLElBQUksb0JBQW9CLEVBQUU7QUFBQSxJQUM1RTtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxNQUNMLFFBQVEsRUFBRSxRQUFRLHlCQUF5QixjQUFjLEtBQUs7QUFBQSxNQUM5RCxlQUFlLEVBQUUsUUFBUSx5QkFBeUIsY0FBYyxLQUFLO0FBQUEsTUFDckUsVUFBVSxFQUFFLFFBQVEsdUJBQXVCLElBQUksS0FBSztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUFLcEQsU0FBUyxFQUFFLFFBQVEsdUJBQXVCLElBQUksS0FBSztBQUFBLElBQ3JEO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
