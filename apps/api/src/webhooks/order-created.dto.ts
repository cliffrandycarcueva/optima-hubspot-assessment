import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsDefined, IsEmail, IsInt,
  IsISO8601, IsISO4217CurrencyCode, IsNumber, IsObject, IsString, Matches,
  Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';

export class CustomerDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  first_name!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  last_name!: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @MaxLength(50)
  phone?: string;
}

export class OrderItemDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  sku!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(500)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  qty!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  price!: number;
}

export class OrderCreatedDto {
  @Equals('order.created')
  event!: 'order.created';

  @IsString()
  @Matches(/^\S(?:.*\S)?$/)
  @MaxLength(200)
  order_id!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  created_at!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerDto)
  customer!: CustomerDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsISO4217CurrencyCode()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  total!: number;
}
