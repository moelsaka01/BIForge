let
	Source = PostgreSQL.Database("h:5432", "d", [Query="SELECT 1 AS Id"])
in
	Source