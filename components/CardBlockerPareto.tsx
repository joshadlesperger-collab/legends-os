"use client";
import {blockerPareto,blockerRccaCsv,causeDefinition,type CauseCode} from "@/lib/card-blocker-causes";
import type {BacklogCard} from "@/lib/card-backlog";
import type {WorkflowSnapshot} from "@/lib/card-workflow";
import styles from "./CardWorkflow.module.css";

export default function CardBlockerPareto({cards,snapshot,summary,selected,onSelect}:{cards:BacklogCard[];snapshot:WorkflowSnapshot;summary:ReturnType<typeof blockerPareto>;selected:CauseCode|"";onSelect:(code:CauseCode|"")=>void}) {
  const chosen=selected?causeDefinition(selected):undefined;
  function download(){
    const url=URL.createObjectURL(new Blob(["\uFEFF",blockerRccaCsv(cards,snapshot)],{type:"text/csv;charset=utf-8"}));
    const a=document.createElement("a");a.href=url;a.download="card-blocker-rcca-pa.csv";a.click();URL.revokeObjectURL(url);
  }
  return <details className={styles.pareto}><summary>Blocker causes · {summary.total} cards · Pareto & RCCA/PA{summary.rows[0]?` · Largest: ${summary.rows[0].code} (${summary.rows[0].count})`:""}</summary>
    <div className={styles.paretoIntro}><p>Current stage scope. Each blocked card counts once under its primary cause. Codes classify saved blocker evidence; the root cause still needs confirmation. Secondary causes remain in card details and the export.</p><button disabled={!summary.total} onClick={download}>Export RCCA/PA worksheet</button></div>
    {summary.total?<div className={styles.paretoRows} role="table" aria-label="Blocker cause Pareto"><div role="row" className={styles.paretoHeader}><span role="columnheader">Primary cause</span><span role="columnheader">Cards</span><span role="columnheader">Share of blocked cards</span><span role="columnheader">Cumulative</span></div>{summary.rows.map(row=><div role="row" key={row.code} className={styles.paretoRow}><div role="cell"><button aria-pressed={selected===row.code} onClick={()=>onSelect(selected===row.code?"":row.code)} title={`Filter ${row.count} cards: ${row.label}`}><b>{row.code}</b> {row.label}</button></div><span role="cell">{row.count}</span><span role="cell" className={styles.causeBar}><span style={{width:`${row.share*100}%`}}/>{(row.share*100).toFixed(1)}%</span><span role="cell">{(row.cumulative*100).toFixed(1)}%</span></div>)}</div>:<p>No blocked cards in this stage scope.</p>}
    {chosen?<div className={styles.causeGuidance}><strong>{chosen.code} · {chosen.label}</strong><span>Suggested owner: {chosen.owner}</span><p><b>Corrective action to investigate:</b> {chosen.correction}</p><p><b>Prevention to investigate:</b> {chosen.prevention}</p></div>:<p className={styles.paretoHint}>Select a cause to filter its cards and see investigation guidance. The worksheet includes blank root-cause, action-owner, due-date and effectiveness-check fields.</p>}
  </details>;
}
