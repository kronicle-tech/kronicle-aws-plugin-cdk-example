import * as AWSXRay from 'aws-xray-sdk-core';
import * as RawAWS from 'aws-sdk';

const AWS = AWSXRay.captureAWS(RawAWS);

const TABLE_NAME = process.env.TABLE_NAME || '';

const db = new AWS.DynamoDB.DocumentClient();

export const handler = async (): Promise<any> => {

  const params = {
    TableName: TABLE_NAME
  };

  try {
    const response = await db.scan(params).promise();
    return { statusCode: 200, body: JSON.stringify(response.Items) };
  } catch (dbError) {
    return { statusCode: 500, body: JSON.stringify(dbError) };
  }
};
