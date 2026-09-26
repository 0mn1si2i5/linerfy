import { NextResponse, type NextRequest } from "next/server";

import { bearerToken, resolveAuthState } from "../../../lib/auth";
import { handleContextRequest } from "../../../lib/context-service";

export const dynamic = "force-dynamic";

// User sessions keep their existing Supabase + GitHub whitelist boundary. The
// content-task state machine is shared with the Pox service route below it.
export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json(
      { error: "missing bearer token" },
      { status: 401 },
    );
  }
  const auth = await resolveAuthState(token);
  if (auth.status === "unauthenticated") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (auth.status === "not-whitelisted") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return handleContextRequest(request);
}
