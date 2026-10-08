/** Read-only label/value grid for profile detail sections. */
export default function DetailGrid({ entries, columns = 'sm:grid-cols-3' }) {
    return (
        <div className={`grid grid-cols-2 gap-2 text-xs ${columns}`}>
            {entries.map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-900/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
                    <p className="mt-0.5 break-words font-medium text-slate-200">
                        {value === null || value === undefined || value === '' ? '—' : String(value)}
                    </p>
                </div>
            ))}
        </div>
    );
}
