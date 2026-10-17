let
	Source = MySQL.Database("db.local:3306", "shop", [Query="SELECT id, name FROM people"])
in
	Source