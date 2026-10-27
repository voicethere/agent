/**
 * The customer-side SQL for the Supabase knowledge store. One source of truth:
 * the README block and the docker test both use this output.
 * Adapted from the Supabase semantic-search and vector-columns guides; the
 * returns clause (id, content, similarity) is what the agent reads.
 */
export function supabaseMatchDocumentsSql(dims: number): string {
  return `create extension if not exists vector;

create table documents (
  id bigint primary key generated always as identity,
  content text not null,
  embedding vector(${dims})
);

create or replace function match_documents (
  query_embedding vector(${dims}),
  match_threshold float,
  match_count int
)
returns table (id bigint, content text, similarity float)
language sql stable
as $$
  select
    documents.id,
    documents.content,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by documents.embedding <=> query_embedding asc
  limit least(match_count, 200);
$$;`;
}
