ALTER TABLE users ADD COLUMN auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX idx_users_auth_id ON users(auth_id);
