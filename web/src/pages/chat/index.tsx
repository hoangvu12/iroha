import { ChatPanel } from "./ChatPanel";

/** /chat: the chat as a full page (phones, and the sheet's expand button). */
export default function ChatPage() {
  return (
    <div className="h-[calc(100dvh-72px-env(safe-area-inset-bottom))] md:h-dvh">
      <ChatPanel mode="page" />
    </div>
  );
}
