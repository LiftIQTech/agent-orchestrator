import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import {
  buildWebhookRequest,
  eventMatchesProject,
  findAffectedSessions,
  findWebhookProjects,
} from "@/lib/scm-webhooks";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const services = await getServices();
    const path = new URL(request.url).pathname;
    const candidates = findWebhookProjects(services.config, services.registry, path);

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "No SCM webhook configured for this path" },
        { status: 404 },
      );
    }

    const rawContentLength = request.headers.get("content-length");
    const contentLength = rawContentLength ? Number(rawContentLength) : NaN;
    const configuredMaxBodyBytes = candidates
      .map((candidate) => candidate.project.scm?.webhook?.maxBodyBytes)
      .filter((value): value is number => typeof value === "number");
    const maxBodyBytes =
      configuredMaxBodyBytes.length > 0 ? Math.min(...configuredMaxBodyBytes) : undefined;
    if (
      maxBodyBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > maxBodyBytes
    ) {
      return NextResponse.json(
        { error: "Webhook payload exceeds configured maxBodyBytes" },
        { status: 413 },
      );
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const body = new TextDecoder().decode(rawBody);
    const webhookRequest = buildWebhookRequest(request, body, rawBody);

    const sessions = await services.sessionManager.list();
    const sessionIds = new Set<string>();
    const projectIds = new Set<string>();
    let verified = false;
    const errors: string[] = [];
    const parseErrors: string[] = [];

    for (const candidate of candidates) {
      const verification = await candidate.scm.verifyWebhook?.(webhookRequest, candidate.project);
      if (!verification?.ok) {
        if (verification?.reason) errors.push(verification.reason);
        continue;
      }
      verified = true;

      let event;
      try {
        event = await candidate.scm.parseWebhook?.(webhookRequest, candidate.project);
      } catch (err) {
        parseErrors.push(err instanceof Error ? err.message : "Invalid webhook payload");
        continue;
      }

      if (!event || !eventMatchesProject(event, candidate.project)) {
        continue;
      }

      projectIds.add(candidate.projectId);
      const affectedSessions = findAffectedSessions(sessions, candidate.projectId, event);
      if (affectedSessions.length === 0) {
        continue;
      }

      const lifecycle = services.lifecycleManager;
      for (const session of affectedSessions) {
        sessionIds.add(session.id);
        await lifecycle.check(session.id);
      }
    }

    if (!verified) {
      return NextResponse.json(
        { error: errors[0] ?? "Webhook verification failed", ok: false },
        { status: 401 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        projectIds: [...projectIds],
        sessionIds: [...sessionIds],
        matchedSessions: sessionIds.size,
        parseErrors,
      },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process SCM webhook" },
      { status: 500 },
    );
  }
}
