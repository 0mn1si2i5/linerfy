import { NextResponse, type NextRequest } from "next/server";

import { handleContextRequest } from "../../../../lib/context-service";
import { isPoxServiceAuthorized } from "../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isPoxServiceAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return handleContextRequest(request);
}
