import * as AWSXRay from 'aws-xray-sdk-core';
import * as RawAWS from 'aws-sdk';
import {AWSError} from "aws-sdk/lib/error";
import {DocumentClient} from "aws-sdk/lib/dynamodb/document_client";
import {PromiseResult} from "aws-sdk/lib/request";

const AWS = AWSXRay.captureAWS(RawAWS);

const TABLE_NAME = process.env.TABLE_NAME || '';
const PRIMARY_KEY = process.env.PRIMARY_KEY || '';

const db = new AWS.DynamoDB.DocumentClient();

export const handler = async (): Promise<any> => {

  try {
    let exclusiveStartKey = undefined;

    console.log('Starting delete all');

    while (true) {
      const scanOutput: PromiseResult<DocumentClient.ScanOutput, AWSError> = await db.scan({
        TableName: TABLE_NAME,
        ExclusiveStartKey: exclusiveStartKey
      }).promise();

      if (scanOutput.ScannedCount === 0 || scanOutput.Items === undefined) {
        break;
      }

      console.log(`Found ${scanOutput.ScannedCount} more items to delete`);

      for (const item of scanOutput.Items) {
        console.log(`Deleting item ${JSON.stringify(item)}`);
        await db.delete({
          TableName: TABLE_NAME,
          Key: {
            [PRIMARY_KEY]: item[PRIMARY_KEY]
          }
        }).promise();
      }

      exclusiveStartKey = scanOutput.LastEvaluatedKey;
    }

    console.log('Finished delete all');

    return { statusCode: 200, body: '' };
  } catch (dbError) {
    return { statusCode: 500, body: JSON.stringify(dbError) };
  }
};
