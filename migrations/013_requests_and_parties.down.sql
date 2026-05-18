-- Migration 013 DOWN: Drop requests and watch parties tables.
-- Reverse dependency order: participants first, then parties, then requests.

DROP TABLE IF EXISTS watch_party_participants CASCADE;
DROP TABLE IF EXISTS watch_parties CASCADE;
DROP TABLE IF EXISTS requests CASCADE;
