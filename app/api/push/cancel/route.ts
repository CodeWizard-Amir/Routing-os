import { NextRequest, NextResponse } from "next/server";
import { getQStashClient, isPushApiAuthorized } from "@/lib/push-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!process.env.PUSH_API_SECRET) {
    return NextResponse.json({ error: "تنظیم PUSH_API_SECRET در Vercel انجام نشده است." }, { status: 503 });
  }
  if (!isPushApiAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "کد اتصال اعلان معتبر نیست." }, { status: 401 });
  }

  try {
    const input = await request.json() as { messageIds?: unknown };
    if (!Array.isArray(input.messageIds) || input.messageIds.length > 100) {
      return NextResponse.json({ error: "فهرست شناسه‌های اعلان معتبر نیست یا بیش از ۱۰۰ مورد دارد." }, { status: 400 });
    }

    const messageIds = [...new Set(input.messageIds.filter((value): value is string =>
      typeof value === "string" && value.length >= 8 && value.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(value)
    ))];

    if (!messageIds.length) return NextResponse.json({ cancelled: 0, requested: 0 });

    const result = await getQStashClient().messages.cancel(messageIds);
    return NextResponse.json({ cancelled: result.cancelled, requested: messageIds.length });
  } catch (error) {
    console.error("Push cancellation failed:", error);
    return NextResponse.json({ error: "لغو اعلان‌های زمان‌بندی‌شده ناموفق بود." }, { status: 502 });
  }
}
