-- Give the security price-alert threshold the same declared scale as its
-- sibling, notification_portfolio_state.move_alert_percent NUMERIC(9,4).
--
-- It shipped as DOUBLE PRECISION with only a range CHECK, so the column had no
-- scale at all while the only control for it renders a fixed number of decimal
-- places. A stored value finer than the control can show is displayed rounded
-- and then committed at that rounding on the next blur, which moves a threshold
-- on a save the user made about another field. A column and its control agree
-- on precision, or the display is a lie.
--
-- NUMERIC(9,4) is not wider than the CHECK already allows (0.1 .. 1000), so no
-- stored value can fail the conversion, and the CHECK survives the type change.
ALTER TABLE securities
    ALTER COLUMN price_alert_percent TYPE NUMERIC(9, 4);
