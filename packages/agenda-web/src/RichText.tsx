import { Fragment, type ReactNode } from "react";

/** Minimal, safe markdown (no innerHTML): paragraphs, "- " lists and **bold**. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export function RichText({ children }: { children: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const closeList = () => {
    if (list.length) {
      blocks.push(
        <ul key={`ul${blocks.length}`}>
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const line of children.split("\n")) {
    const item = line.match(/^\s*[-•*]\s+(.*)$/);
    if (item) {
      list.push(item[1]!);
      continue;
    }
    closeList();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  closeList();
  return <>{blocks}</>;
}
