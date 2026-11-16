// Called only after the release catalog's signature has been verified.
export function phoenixNotes(catalog) {
  const rows=catalog.releases.filter(r=>r.project==='phoenix'&&r.device==='sticks3');
  if(rows.length!==1)return {title:'Phoenix Link',qualification:'No single Phoenix release is listed in the verified catalog.',manual:null,source:null};
  const r=rows[0];
  return {title:`Phoenix Link · ${r.version}`,qualification:r.qualification,manual:r.manual,source:r.source};
}
export function renderPhoenixNotes(catalog,doc=document) {
  const notes=phoenixNotes(catalog);
  const summary=doc.getElementById('phoenix-summary');const paragraph=doc.getElementById('phoenix-release-note');
  if(summary)summary.textContent=notes.title;if(paragraph)paragraph.textContent=notes.qualification;
  for(const key of ['manual','source']){const a=doc.getElementById('phoenix-'+key);if(a){a.hidden=!notes[key];if(notes[key])a.href=notes[key];}}
}
