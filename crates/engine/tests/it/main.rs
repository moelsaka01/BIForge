//! All integration tests of the engine in one binary: each test binary links DuckDB (hundreds of MB in a debug build), so one binary instead of fifteen keeps target/ small.
mod fixture;
mod analysis_services_live;
mod connectors;
mod dax_conformance;
mod dax_probe;
mod dax_sql;
mod import;
mod m_partitions;
mod m_phase9;
mod m_queries;
mod m_stdlib;
mod m_transforms;
mod oledb;
mod quick_measures;
mod report_queries;
mod scripts_live;
