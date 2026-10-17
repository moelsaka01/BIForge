let
	Source = #table(type table [#"Name" = text, #"Qty" = Int64.Type, #"Price" = number, #"Ok" = logical, #"Day" = date, #"At" = datetime], {{"a ""q""", 2, 1.5, true, #date(2024, 1, 2), #datetime(2024, 1, 2, 3, 4, 0)}, {null, null, null, null, null, null}})
in
	Source