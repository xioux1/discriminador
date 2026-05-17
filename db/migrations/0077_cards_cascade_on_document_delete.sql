-- cards.document_id tenía ON DELETE SET NULL: al borrar un documento las cards
-- quedaban huérfanas. Se cambia a CASCADE para que se eliminen junto al documento.
--
-- cards.cluster_id se mantiene SET NULL porque los clusters pueden borrarse de forma
-- independiente (re-clustering) sin que el usuario quiera perder sus cards existentes.

ALTER TABLE cards
  DROP CONSTRAINT IF EXISTS cards_document_id_fkey;

ALTER TABLE cards
  ADD CONSTRAINT cards_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
