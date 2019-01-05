# TRON Simulator

Tron simulator is used to simulate Tron performance with orders and drivers in one region at a specific time.

We can use this simulator to verify new feature or test parameters for TRON.

## REQUIREMENTS

1.Node.js 8 or above

## Environment Variables
| Env                         | Description |
| ---                         | ---         |
| DATASOURCE_MONGO_URI        | Mongodb URI of datasource we need to simulate    |
| SIMULATE_DATA_MONGO_URI     | Mongodb we used to save simulate result |
| TRON_HOSTNAME               | URI of Tron proxy service |

## RUN Simulator
1.Edit data.js, set datetime and region ID when and where we need to simulate.   
2.Run simulator
```shell
node process.js
```

## How to analyze the results of simulator
After running the simulator, we can find three collections: accounts, orders and events in the database tron-simulate. We can do some comparisions with actual data.
We can also use TRON-map to trace the event by the created time to analyze the routes of drivers.
