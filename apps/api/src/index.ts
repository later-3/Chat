import { serve } from "@hono/node-server";
import { createApiApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: createApiApp().fetch, port }, (info) => {
  console.log(`chat-api listening on http://localhost:${info.port}`);
});
