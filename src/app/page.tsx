import type { ReactElement } from "react";
import { Workspace } from "../components/Workspace";

interface PageProps {
  readonly searchParams: Promise<{ readonly room?: string | string[] }>;
}

export default async function Page({ searchParams }: PageProps): Promise<ReactElement> {
  const { room } = await searchParams;
  const roomId = (Array.isArray(room) ? room[0] : room)?.trim() || "demo";
  return <Workspace room={roomId} />;
}
