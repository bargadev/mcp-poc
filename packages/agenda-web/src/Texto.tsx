import { Fragment, type ReactNode } from "react";

/** Markdown mínimo e seguro (sem innerHTML): parágrafos, listas "- " e **negrito**. */
function inline(texto: string): ReactNode[] {
  return texto.split(/(\*\*[^*]+\*\*)/g).map((parte, i) =>
    parte.startsWith("**") && parte.endsWith("**") ? <strong key={i}>{parte.slice(2, -2)}</strong> : <Fragment key={i}>{parte}</Fragment>,
  );
}

export function Texto({ children }: { children: string }) {
  const blocos: ReactNode[] = [];
  let lista: string[] = [];
  const fecharLista = () => {
    if (lista.length) {
      blocos.push(
        <ul key={`ul${blocos.length}`}>
          {lista.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      lista = [];
    }
  };
  for (const linha of children.split("\n")) {
    const item = linha.match(/^\s*[-•*]\s+(.*)$/);
    if (item) {
      lista.push(item[1]!);
      continue;
    }
    fecharLista();
    if (linha.trim()) blocos.push(<p key={`p${blocos.length}`}>{inline(linha)}</p>);
  }
  fecharLista();
  return <>{blocos}</>;
}
