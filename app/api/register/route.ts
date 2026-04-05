import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { cars, settings, selectedJson } = body;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const scriptPath = path.join(process.cwd(), "scripts", "register.py");

      const proc = spawn("python3", [scriptPath], {
        env: {
          ...process.env,
          NICEPARK_URL: settings.url,
          NICEPARK_ID: settings.id,
          NICEPARK_PW: settings.pw,
          CARS_JSON: JSON.stringify(cars),
          SELECTED_JSON: JSON.stringify(selectedJson || {}),
        },
      });

      proc.stdout.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        console.error("[register.py]", data.toString());
      });

      proc.on("close", () => {
        controller.enqueue(encoder.encode("data: {\"done\":true}\n\n"));
        controller.close();
      });

      proc.on("error", (err) => {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: err.message })}\n\n`
          )
        );
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
