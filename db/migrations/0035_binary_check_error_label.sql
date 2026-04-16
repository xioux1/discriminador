-- Classify binary check errors as conceptual vs syntactic.
-- error_type:  'conceptual' | 'syntactic' — only set when result = 'error'
-- error_label: short description of the conceptual error (only when error_type = 'conceptual')
ALTER TABLE binary_check_log
  ADD COLUMN IF NOT EXISTS error_type  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS error_label TEXT;
