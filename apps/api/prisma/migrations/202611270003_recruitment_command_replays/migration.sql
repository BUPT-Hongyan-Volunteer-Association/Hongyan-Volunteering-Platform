BEGIN;

-- Successful retries read the original result envelope directly. Rewrite only the
-- typed activity/review/registration result paths, preserving IDs, digests and audit facts.
CREATE FUNCTION pg_temp.recruitment_replay(method text, path text, result jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    retired CONSTANT text[] := ARRAY['eligibility_text','selection_text','expected_hours','expected_hours_basis'];
    id_pattern CONSTANT text := '[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
    route text := rtrim(path, '/');
    snapshot_key text;
    items jsonb;
BEGIN
    IF (method='POST' AND route='/api/v1/organizer/activities') OR
       (method='PATCH' AND route ~ ('^/api/v1/organizer/activities/' || id_pattern || '$')) THEN
        RETURN result - retired;
    END IF;
    IF method <> 'POST' THEN RETURN result; END IF;

    IF route ~ ('^/api/v1/(organizer/activities/' || id_pattern || '/submit|organizer/activity-reviews/' ||
                id_pattern || '/withdraw|admin/activity-reviews/' || id_pattern || '/decision)$') THEN
        FOREACH snapshot_key IN ARRAY ARRAY['snapshot','previous_published_snapshot'] LOOP
            IF (result #> ARRAY[snapshot_key,'content']) ?| retired THEN
                result := jsonb_set(result, ARRAY[snapshot_key,'content'], (result #> ARRAY[snapshot_key,'content']) - retired);
            END IF;
        END LOOP;
        IF jsonb_typeof(result->'changes') = 'array' THEN
            SELECT coalesce(jsonb_agg(change ORDER BY ord), '[]') INTO items
            FROM jsonb_array_elements(result->'changes') WITH ORDINALITY AS diff(change,ord)
            WHERE NOT coalesce(change->>'field_path'=ANY(retired),false);
            result := jsonb_set(result, '{changes}', items);
        END IF;
    ELSIF route ~ ('^/api/v1/(me/registrations/' || id_pattern || '/withdraw|organizer/registrations/' ||
                  id_pattern || '/decision)$') THEN
        RETURN result - 'statement';
    ELSIF route ~ ('^/api/v1/activities/' || id_pattern || '/registrations$') AND result ? 'student_id' THEN
        RETURN jsonb_build_object('items', jsonb_build_array(result - 'statement'));
    ELSIF route ~ ('^/api/v1/(activities/' || id_pattern || '/registrations|organizer/activities/' ||
                  id_pattern || '/registration-decisions)$') AND jsonb_typeof(result->'items') = 'array' THEN
        SELECT coalesce(jsonb_agg(item - 'statement' ORDER BY ord), '[]') INTO items
        FROM jsonb_array_elements(result->'items') WITH ORDINALITY AS rows(item,ord);
        result := jsonb_set(result, '{items}', items);
    END IF;
    RETURN result;
END $$;

WITH normalized AS MATERIALIZED (
    SELECT account_id,method,path,key,pg_temp.recruitment_replay(method,path,response->'data') AS data
    FROM command_receipt WHERE method IN ('POST','PATCH') AND jsonb_typeof(response->'data')='object'
)
UPDATE command_receipt c SET response=jsonb_set(c.response,'{data}',n.data)
FROM normalized n WHERE (c.account_id,c.method,c.path,c.key)=(n.account_id,n.method,n.path,n.key)
  AND c.response->'data' IS DISTINCT FROM n.data;

DROP FUNCTION pg_temp.recruitment_replay(text,text,jsonb);
COMMIT;
