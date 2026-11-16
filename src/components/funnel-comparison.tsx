import type {PlotRow} from '@/models/metrics/visualization';
export function FunnelComparison({rows}:{rows:PlotRow[]}){
 const rate=(value:number,base:number)=>base?`${(100*value/base).toFixed(1)}%`:'—';
 const currentBase=Number(rows[0]?.value??0),previousBase=Number(rows[0]?.previous??0);
 return <div className="overflow-auto mt-4"><table className="w-full text-sm"><caption className="text-left mb-2">Period comparison · unique participants and conversion</caption><thead><tr><th className="text-left p-2">Step</th><th className="p-2">Selected</th><th className="p-2">Comparison</th><th className="p-2">Change (pp)</th></tr></thead><tbody>{rows.map(r=><tr key={r.key}><td className="p-2">{r.label}</td><td className="text-center p-2">{r.value}<span className="block text-xs text-muted-foreground">{rate(Number(r.value),currentBase)}</span></td><td className="text-center p-2">{r.previous??'—'}<span className="block text-xs text-muted-foreground">{rate(Number(r.previous),previousBase)}</span></td><td className="text-center p-2">{currentBase&&previousBase?(100*(Number(r.value)/currentBase-Number(r.previous)/previousBase)).toFixed(1):'—'}</td></tr>)}</tbody></table></div>;
}
