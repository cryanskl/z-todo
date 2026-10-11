//! 宿主端口冒烟测试：读取 tests/fixtures/host-smoke.json，与 TypeScript 测试宿主跑同一份场景。

use serde::Deserialize;
use serde_json::{Map, Value as Json};
use zt_db::{open_in_memory, query, tx, DbError, Stmt, TxPlan};

const CONTRACT: &str = include_str!("../../../../../tests/fixtures/host-smoke.json");

#[derive(Deserialize)]
struct Contract {
    seeds: Map<String, Json>,
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
struct Scenario {
    name: String,
    #[serde(default)]
    seeds: Vec<String>,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Step {
    Query {
        query: String,
        #[serde(default)]
        params: Vec<Json>,
        expect: Expect,
    },
    Tx {
        tx: Vec<StmtJson>,
        expect: Expect,
    },
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StmtJson {
    sql: String,
    #[serde(default)]
    params: Vec<Json>,
    #[serde(default)]
    expect_changes: Option<u64>,
}

impl From<StmtJson> for Stmt {
    fn from(s: StmtJson) -> Self {
        Stmt {
            sql: s.sql,
            params: s.params,
            expect_changes: s.expect_changes,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expect {
    columns: Option<Vec<String>>,
    rows: Option<Vec<Map<String, Json>>>,
    changes: Option<Vec<u64>>,
    error: Option<ExpectError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectError {
    kind: String,
    statement_index: Option<usize>,
}

fn check_error(scenario: &str, step: usize, err: &DbError, want: &ExpectError) {
    let kind = serde_json::to_value(err.kind).unwrap();
    assert_eq!(
        kind,
        Json::String(want.kind.clone()),
        "[{scenario}] 第 {step} 步错误类型不符：{err}"
    );
    if let Some(idx) = want.statement_index {
        assert_eq!(
            err.statement_index,
            Some(idx),
            "[{scenario}] 第 {step} 步出错语句下标不符：{err}"
        );
    }
}

#[test]
fn host_smoke_contract() {
    let contract: Contract = serde_json::from_str(CONTRACT).expect("冒烟契约 JSON 格式错误");
    assert!(!contract.scenarios.is_empty());

    for sc in &contract.scenarios {
        let mut conn = open_in_memory().unwrap();
        for seed in &sc.seeds {
            let stmts: Vec<StmtJson> =
                serde_json::from_value(contract.seeds[seed].clone()).expect("seed 格式错误");
            tx(
                &mut conn,
                &TxPlan {
                    statements: stmts.into_iter().map(Into::into).collect(),
                },
            )
            .unwrap_or_else(|e| panic!("[{}] seed {seed} 失败：{e}", sc.name));
        }

        for (i, step) in sc.steps.iter().enumerate() {
            match step {
                Step::Query {
                    query: sql,
                    params,
                    expect,
                } => {
                    let res = query(&conn, sql, params);
                    match (&expect.error, res) {
                        (Some(want), Err(e)) => check_error(&sc.name, i, &e, want),
                        (Some(_), Ok(r)) => {
                            panic!("[{}] 第 {i} 步期望出错，实际返回 {r:?}", sc.name)
                        }
                        (None, Err(e)) => panic!("[{}] 第 {i} 步查询失败：{e}", sc.name),
                        (None, Ok(r)) => {
                            if let Some(cols) = &expect.columns {
                                assert_eq!(&r.columns, cols, "[{}] 第 {i} 步列不符", sc.name);
                            }
                            if let Some(rows) = &expect.rows {
                                let got: Vec<Map<String, Json>> = r
                                    .rows
                                    .iter()
                                    .map(|row| {
                                        r.columns.iter().cloned().zip(row.iter().cloned()).collect()
                                    })
                                    .collect();
                                assert_eq!(&got, rows, "[{}] 第 {i} 步结果不符", sc.name);
                            }
                        }
                    }
                }
                Step::Tx { tx: stmts, expect } => {
                    let plan = TxPlan {
                        statements: stmts.iter().cloned().map(Into::into).collect(),
                    };
                    let res = tx(&mut conn, &plan);
                    match (&expect.error, res) {
                        (Some(want), Err(e)) => check_error(&sc.name, i, &e, want),
                        (Some(_), Ok(r)) => {
                            panic!("[{}] 第 {i} 步期望出错，实际成功 {r:?}", sc.name)
                        }
                        (None, Err(e)) => panic!("[{}] 第 {i} 步事务失败：{e}", sc.name),
                        (None, Ok(r)) => {
                            if let Some(changes) = &expect.changes {
                                assert_eq!(
                                    &r.changes, changes,
                                    "[{}] 第 {i} 步影响行数不符",
                                    sc.name
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
