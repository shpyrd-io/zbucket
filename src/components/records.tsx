import type {ReactNode} from 'react';
export function Table({heads,rows}:{heads:string[];rows:ReactNode[][]}){return <div className="table-wrap"><table><thead><tr>{heads.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;}
