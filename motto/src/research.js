import { signReading } from './checks.js';

export function researchRequestError(body) {
  if (typeof body?.query !== 'string' || body.query.trim().length < 3 || body.query.length > 200) return 'query must be a topic between 3 and 200 characters';
}

export function citationPack(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap(item => {
    const doi = typeof item.DOI === 'string' ? item.DOI.trim() : '';
    const title = typeof item.title?.[0] === 'string' ? item.title[0].trim() : '';
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi) || !title || seen.has(doi.toLowerCase())) return [];
    seen.add(doi.toLowerCase());
    return [{ title: title.slice(0,500), doi, url: 'https://doi.org/' + encodeURIComponent(doi), publisher: typeof item.publisher === 'string' ? item.publisher.slice(0,200) : null }];
  }).slice(0,3);
}

export async function checkResearch({ holdId, query, onUpdate, fetcher = fetch }) {
  const topic = query.trim();
  onUpdate?.({status:'fetching', query:topic, provider:'Crossref'});
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({query:topic,rows:'8',select:'DOI,title,publisher'}).toString();
  let citations=[], error;
  try {
    const response=await fetcher(url,{headers:{Accept:'application/json','User-Agent':'Motto-Hackathon-Demo/1.0'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`Crossref HTTP ${response.status}`);
    const data=await response.json();
    citations=citationPack(data.message?.items);
  } catch(e) {error=String(e.message).slice(0,200);}
  onUpdate?.({status:'validating',query:topic,provider:'Crossref'});
  const complete = !error && citations.length===3;
  return signReading({holdId,item:'research',outcome:complete?'delivered':'inconclusive',detail:complete?'citation_pack_delivered':'citation_pack_incomplete',query:topic,provider:'Crossref public metadata API',raw:complete?'3 distinct DOI-backed citation records delivered':error??`Only ${citations.length} valid records returned`,checks:{required_count:3,received_count:citations.length,distinct_dois:citations.length===new Set(citations.map(c=>c.doi.toLowerCase())).size,titles_present:citations.every(c=>Boolean(c.title)),passed:complete},deliverable:{type:'citation_pack',query:topic,citations},limitations:'Checks cover count, unique DOI identifiers and nonempty titles. They do not establish semantic relevance, paper quality, DOI resolution or full-text access. Crossref metadata is public; this service packages and verifies it.',ts:Date.now()});
}
